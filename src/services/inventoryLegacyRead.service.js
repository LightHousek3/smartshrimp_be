const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    inventoryHistoryOptionsService: { getHistoryOptions },
} = require('./index');

const READ_ONLY_MESSAGE = 'Kho hiện chỉ hỗ trợ xem dữ liệu. Cần đồng bộ dữ liệu kho trước khi cập nhật.';
let modePromise;
let modeExpires = 0;

/**
 * Detect schema capability; incomplete legacy facts are marked separately in V2 DTOs.
 */
const isV2 = () => {
    if (!modePromise || Date.now() >= modeExpires) {
        modeExpires = Date.now() + 30000;
        modePromise = prisma.$queryRaw`SELECT
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='products' AND column_name='manufacturer_id')
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='suppliers' AND column_name='owner_id')
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='inventory_balances' AND column_name='expiry_date')
            AND to_regclass('product_compliance') IS NOT NULL AS ready`
            .then(([row]) => row.ready).catch((error) => {
                modePromise = null;
                throw error;
            });
    }
    return modePromise;
};

/**
 * Reject writes while the connected schema lacks required V2 inventory fields.
 */
const requireV2 = async () => {
    if (!await isV2()) {
        throw new ApiError(409, READ_ONLY_MESSAGE);
    }
};

/**
 * Check schema capability before forwarding the original write arguments.
 */
const guardWrite = (work) => async (...args) => {
    await requireV2();
    return work(...args);
};

const camel = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/gu, (_, c) => c.toUpperCase()), value]));
const amount = (value) => new Prisma.Decimal(value ?? 0);
const flags = {
    schemaVersion: 1,
    readOnly: true,
};

/**
 * Apply ownership and legacy deletion checks without selecting V2-only columns.
 */
const requireFarm = async (farmId, ownerId) => {
    const [farm] = await prisma.$queryRaw`SELECT id, name FROM farms f WHERE id=${farmId}::uuid AND owner_id=${ownerId}::uuid AND COALESCE(to_jsonb(f)->>'is_deleted','false') <> 'true'`;
    if (!farm) {
        throw new ApiError(404, 'Không tìm thấy trang trại.');
    }
    return farm;
};

const balanceDto = (row) => {
    const b = camel(row);
    const quantity = amount(b.quantityExact ?? b.quantity);
    return {
        ...b,
        quantity: Number(quantity),
        quantityExact: quantity.toFixed(),
        unitPrice: Number(b.unitPrice),
        supplierName: b.supplierName ?? b.supplierNameSnapshot,
        expiryDate: b.expiryDate ?? null,
        inventoryValue: Number(quantity.mul(b.unitPrice)),
        receivedQuantity: b.receivedQuantity == null ? null : Number(b.receivedQuantity),
    };
};

const productDto = (row, balances, includeLots = false) => {
    const p = camel(row);
    const stock = balances.reduce((sum, b) => sum.add(b.quantityExact), amount(0));
    const value = balances.reduce((sum, b) => sum.add(amount(b.quantityExact).mul(b.unitPrice)), amount(0));
    const alertStock = ['pack', 'bottle'].includes(p.unit) && p.conversionUnit && amount(p.conversionQuantity).gt(0)
        ? stock.mul(p.conversionQuantity) : stock;
    return {
        ...p,
        ...flags,
        status: p.status.toUpperCase(),
        category: p.category.toUpperCase(),
        unit: p.unit.toUpperCase(),
        conversionUnit: p.conversionUnit?.toUpperCase() ?? null,
        conversionQuantity: p.conversionQuantity == null ? null : Number(p.conversionQuantity),
        minAlertQuantity: Number(p.minAlertQuantity),
        manufacturerId: null,
        manufacturer: null,
        compliance: null,
        metadataLocked: true,
        canDelete: false,
        canArchive: false,
        imageUrls: p.imageUrls?.length ? p.imageUrls : p.imageUrl ? [p.imageUrl] : [],
        currentStock: Number(stock),
        inventoryValue: Number(value),
        activeLotCount: balances.filter((b) => amount(b.quantityExact).gt(0)).length,
        isLowStock: amount(p.minAlertQuantity).gt(0) && alertStock.lt(p.minAlertQuantity),
        ...(includeLots && { lots: balances }),
    };
};

/**
 * Read legacy columns through JSON so missing V2 columns are never selected.
 */
const productRows = (farmId, ownerId, productId) => prisma.$queryRaw(Prisma.sql`
    SELECT to_jsonb(p) AS product,
        COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('quantity_exact',b.quantity::text,
            'received_quantity',(SELECT sum(inbound.quantity) FROM inventory_transactions inbound
                WHERE inbound.inventory_balance_id=b.id AND inbound.transaction_type::text IN ('stock_in','adjustment_in')))
            ORDER BY b.received_at,b.id) FROM inventory_balances b WHERE b.product_id=p.id), '[]'::jsonb) AS balances
    FROM products p JOIN farms f ON f.id=p.farm_id
    WHERE p.farm_id=${farmId}::uuid AND f.owner_id=${ownerId}::uuid
        AND COALESCE(to_jsonb(p)->>'is_deleted','false') <> 'true'
        ${productId ? Prisma.sql`AND p.id=${productId}::uuid` : Prisma.empty}
    ORDER BY p.created_at DESC,p.id DESC`);
/**
 * Return a read-only legacy catalog with filtered pagination and stock summaries.
 */
const getProducts = async (farmId, ownerId, query) => {
    await requireFarm(farmId, ownerId);
    const all = (await productRows(farmId, ownerId)).map((row) => productDto(row.product, row.balances.map(balanceDto)));
    const {
        page = 1, limit = 20, search = '', category, stockStatus = 'ALL', archiveStatus = 'ACTIVE',
    } = query;
    const candidates = all.filter((p) => (archiveStatus === 'ALL' || p.status === (archiveStatus === 'ARCHIVED' ? 'INACTIVE' : 'ACTIVE'))
        && (!search || p.name.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')))
        && (!category || p.category === category) && (stockStatus !== 'LOW' || p.isLowStock));
    const active = all.filter((p) => p.status === 'ACTIVE');
    return {
        products: candidates.slice((page - 1) * limit, page * limit),
        meta: {
            ...flags,
            page,
            limit,
            totalResults: candidates.length,
            totalPages: Math.ceil(candidates.length / limit),
            hasNextPage: page * limit < candidates.length,
            summary: {
                totalProducts: active.length,
                lowStockCount: active.filter((p) => p.isLowStock).length,
                inventoryValue: active.reduce((sum, p) => sum + p.inventoryValue, 0),
            },
        },
    };
};

/**
 * Read an owned legacy product and its receipt layers without inventing V2 facts.
 */
const getProduct = async (farmId, productId, ownerId) => {
    const farm = await requireFarm(farmId, ownerId);
    const [row] = await productRows(farmId, ownerId, productId);
    if (!row) {
        throw new ApiError(404, 'Không tìm thấy vật tư.');
    }
    return {
        ...productDto(row.product, row.balances.map(balanceDto), true),
        farm,
    };
};

const supplierDto = (row) => {
    const s = camel(row);
    return {
        ...s,
        ...flags,
        ownerId: s.ownerId,
        status: s.isActive === false ? 'INACTIVE' : 'ACTIVE',
        supplierType: 'UNKNOWN',
        canDelete: false,
        manufacturedProductCount: null,
        receiptCount: Number(s.receiptCount ?? 0),
    };
};

const supplierRows = (ownerId, supplierId) => prisma.$queryRaw(Prisma.sql`
    SELECT to_jsonb(s) || jsonb_build_object('owner_id',f.owner_id,'receipt_count',
        (SELECT count(*) FROM inventory_balances b JOIN products p ON p.id=b.product_id JOIN farms pf ON pf.id=p.farm_id
         WHERE b.supplier_id=s.id AND pf.owner_id=${ownerId}::uuid)) AS supplier
    FROM suppliers s JOIN farms f ON f.id=s.farm_id
    WHERE f.owner_id=${ownerId}::uuid AND COALESCE(to_jsonb(s)->>'is_deleted','false') <> 'true'
        ${supplierId ? Prisma.sql`AND s.id=${supplierId}::uuid` : Prisma.empty}
    ORDER BY s.name,s.id`);
/**
 * List legacy suppliers across the owner's farms with explicit unknown roles.
 */
const getSuppliers = async (farmId, ownerId, query = {}) => {
    await requireFarm(farmId, ownerId);
    const {
        page = 1, limit = 100, search = '', status, supplierType,
    } = query;
    const all = (await supplierRows(ownerId)).map((row) => supplierDto(row.supplier)).filter((s) => (!status || s.status === status)
        && (!supplierType || s.supplierType === supplierType)
        && (!search || [s.name, s.phone, s.contactName, s.email].some((v) => v?.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')))));
    return {
        suppliers: all.slice((page - 1) * limit, page * limit),
        meta: {
            ...flags,
            page,
            limit,
            totalResults: all.length,
            totalPages: Math.ceil(all.length / limit),
            hasNextPage: page * limit < all.length,
        },
    };
};

/**
 * Read an owned legacy supplier and a bounded preview of its recent receipt layers.
 */
const getSupplier = async (farmId, supplierId, ownerId) => {
    await requireFarm(farmId, ownerId);
    const [row] = await supplierRows(ownerId, supplierId);
    if (!row) {
        throw new ApiError(404, 'Không tìm thấy nhà cung cấp.');
    }
    const receipts = await prisma.$queryRaw`SELECT b.id,b.product_id AS "productId",p.name AS "productName",p.farm_id AS "farmId",f.name AS "farmName",
        b.lot_number AS "lotNumber",b.received_at AS "receivedAt",b.quantity::text AS "quantityExact",p.unit::text AS unit
        FROM inventory_balances b JOIN products p ON p.id=b.product_id JOIN farms f ON f.id=p.farm_id
        WHERE b.supplier_id=${supplierId}::uuid AND f.owner_id=${ownerId}::uuid ORDER BY b.received_at DESC,b.id LIMIT 20`;
    return {
        ...supplierDto(row.supplier),
        manufacturedProducts: null,
        receipts: receipts.map((receipt) => ({
            ...receipt,
            quantityExact: amount(receipt.quantityExact).toFixed(),
            unit: receipt.unit.toUpperCase(),
        })),
    };
};

/**
 * Preserve ledger history, scoped cursors and server-side totals on the old schema.
 */
const getInventoryHistory = async (farmId, ownerId, query) => {
    await requireFarm(farmId, ownerId);
    const {
        cursor, limit = 10, productId, transactionType, seasonId, referenceType, referenceId, createdFrom, createdTo, search,
    } = query;
    const where = Prisma.sql`p.farm_id=${farmId}::uuid AND f.owner_id=${ownerId}::uuid
        ${productId ? Prisma.sql`AND t.product_id=${productId}::uuid` : Prisma.empty}
        ${transactionType ? Prisma.sql`AND t.transaction_type::text=${transactionType.toLowerCase()}` : Prisma.empty}
        ${seasonId ? Prisma.sql`AND t.season_id=${seasonId}::uuid` : Prisma.empty}
        ${referenceType ? Prisma.sql`AND t.reference_type=${referenceType} AND t.reference_id=${referenceId}::uuid` : Prisma.empty}
        ${createdFrom ? Prisma.sql`AND t.created_at>=${createdFrom}` : Prisma.empty}
        ${createdTo ? Prisma.sql`AND t.created_at<=${createdTo}` : Prisma.empty}`;
    const searchWhere = search ? Prisma.sql`AND (strpos(lower(p.name),lower(${search}))>0
        OR EXISTS (SELECT 1 FROM inventory_balances sb WHERE sb.id=t.inventory_balance_id
            AND (strpos(lower(sb.lot_number),lower(${search}))>0 OR strpos(lower(sb.supplier_name),lower(${search}))>0))
        OR strpos(lower(coalesce(t.reason,'')),lower(${search}))>0)` : Prisma.empty;
    const filteredWhere = Prisma.sql`${where} ${searchWhere}`;
    let after = Prisma.empty;
    if (cursor) {
        const [row] = await prisma.$queryRaw(Prisma.sql`SELECT t.created_at FROM inventory_transactions t JOIN products p ON p.id=t.product_id JOIN farms f ON f.id=p.farm_id WHERE ${filteredWhere} AND t.id=${cursor}::uuid`);
        if (!row) {
            throw new ApiError(400, 'Con trỏ lịch sử kho không hợp lệ.');
        }
        after = Prisma.sql`AND (t.created_at,t.id)<(SELECT c.created_at,c.id FROM inventory_transactions c WHERE c.id=${cursor}::uuid)`;
    }
    const [rows, [totals], filterOptions] = await Promise.all([
        prisma.$queryRaw(Prisma.sql`SELECT to_jsonb(t) || jsonb_build_object('quantity_exact',t.quantity::text) AS transaction,
            to_jsonb(p) AS product,to_jsonb(b) || jsonb_build_object('quantity_exact',b.quantity::text) AS balance,
            jsonb_build_object('id',a.id,'fullName',a.full_name,'email',a.email) AS performer,
            CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'name',s.name,'pond',jsonb_build_object('name',pond.name)) END AS season
            FROM inventory_transactions t JOIN products p ON p.id=t.product_id JOIN farms f ON f.id=p.farm_id
            JOIN inventory_balances b ON b.id=t.inventory_balance_id JOIN accounts a ON a.id=t.performed_by
            LEFT JOIN aquaculture_seasons s ON s.id=t.season_id LEFT JOIN ponds pond ON pond.id=s.pond_id
            WHERE ${filteredWhere} ${after} ORDER BY t.created_at DESC,t.id DESC LIMIT ${limit + 1}`),
        prisma.$queryRaw(Prisma.sql`SELECT count(*)::int AS total,
            coalesce(sum(t.total_amount) FILTER (WHERE t.transaction_type::text IN ('stock_in','adjustment_in')),0) AS inbound,
            coalesce(sum(t.total_amount) FILTER (WHERE t.transaction_type::text IN ('stock_out','adjustment_out')),0) AS outbound
            FROM inventory_transactions t JOIN products p ON p.id=t.product_id JOIN farms f ON f.id=p.farm_id WHERE ${filteredWhere}`),
        getHistoryOptions(farmId),
    ]);
    const transactions = rows.slice(0, limit).map((row) => {
        const t = camel(row.transaction);
        delete t.idempotencyKey;
        return {
            ...t,
            quantity: Number(t.quantity),
            quantityExact: t.quantityExact,
            totalAmount: Number(t.totalAmount),
            transactionType: t.transactionType.toUpperCase(),
            unitSnapshot: t.unitSnapshot.toUpperCase(),
            product: {
                id: row.product.id,
                name: row.product.name,
                category: row.product.category.toUpperCase(),
                unit: row.product.unit.toUpperCase(),
            },
            inventoryBalance: balanceDto(row.balance),
            performer: row.performer,
            season: row.season,
        };
    });
    const hasNextPage = rows.length > limit;
    return {
        transactions,
        meta: {
            ...flags,
            limit,
            totalResults: totals.total,
            hasNextPage,
            nextCursor: hasNextPage ? transactions.at(-1).id : null,
            filterOptions,
            summary: {
                totalInboundValue: Number(totals.inbound),
                totalOutboundValue: Number(totals.outbound),
            },
        },
    };
};

module.exports = {
    isV2,
    guardWrite,
    getProducts,
    getProduct,
    getInventoryHistory,
    getSuppliers,
    getSupplier,
};
