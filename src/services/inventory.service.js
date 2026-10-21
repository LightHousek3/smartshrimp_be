const { randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    PRODUCT_UNIT,
    PRODUCT_STOCK_STATUS,
    PRODUCT_ARCHIVE_STATUS,
    INVENTORY_TRANSACTION_TYPE,
    OWNER_INVENTORY_TRANSACTION_TYPES,
    NOTIFICATION_TYPE,
    INVENTORY_LIMITS,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

const PACKAGED_UNITS = new Set([PRODUCT_UNIT.PACK, PRODUCT_UNIT.BOTTLE]);
const UNIT_LOCKED_FIELDS = ['unit', 'conversionQuantity', 'conversionUnit'];

const PRODUCT_SELECT = {
    id: true,
    farmId: true,
    name: true,
    category: true,
    unit: true,
    conversionQuantity: true,
    conversionUnit: true,
    minAlertQuantity: true,
    description: true,
    status: true,
    recommendationReason: true,
    complianceDetails: true,
    imageUrl: true,
    imageUrls: true,
    archivedAt: true,
    isDeleted: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
};

const BALANCE_SELECT = {
    id: true,
    productId: true,
    lotNumber: true,
    receivedAt: true,
    quantity: true,
    unitPrice: true,
    supplierName: true,
    supplierId: true,
    createdAt: true,
    updatedAt: true,
};

const TRANSACTION_SELECT = {
    id: true,
    transactionGroupId: true,
    productId: true,
    inventoryBalanceId: true,
    seasonId: true,
    transactionType: true,
    quantity: true,
    unitSnapshot: true,
    totalAmount: true,
    referenceType: true,
    referenceId: true,
    reason: true,
    performedBy: true,
    idempotencyKey: true,
    createdAt: true,
};

const decimal = (value) => new Prisma.Decimal(value ?? 0);
// Thresholds are entered in the conversion unit for packaged products.
// Ledger quantities remain in the product's stock unit (PACK/BOTTLE).
const stockInAlertUnit = (product, quantity) => {
    const stock = decimal(quantity);
    return PACKAGED_UNITS.has(product.unit)
        && product.conversionUnit
        && decimal(product.conversionQuantity).gt(0)
        ? stock.mul(product.conversionQuantity)
        : stock;
};
const alertUnit = (product) => PACKAGED_UNITS.has(product.unit)
    && product.conversionUnit && decimal(product.conversionQuantity).gt(0)
    ? product.conversionUnit : product.unit;
const decimalEqual = (left, right) => decimal(left).equals(decimal(right));
const calculateTransactionAmount = (quantity, unitPrice) => {
    const amount = decimal(quantity).mul(unitPrice).toDecimalPlaces(2);
    if (amount.gt(INVENTORY_LIMITS.MAX_TRANSACTION_AMOUNT)) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.INVENTORY.AMOUNT_LIMIT_EXCEEDED);
    }
    return amount;
};
const normalizeNameKey = (value) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');
// API dates have millisecond precision; PostgreSQL rows may retain microseconds.
const versionRange = (date) => ({ gte: date, lt: new Date(date.getTime() + 1) });

const normalizeBalance = (balance) => {
    const { transactions, ...base } = balance;
    const received = Array.isArray(transactions) && transactions.length
        ? transactions.reduce((total, row) => total.add(row.quantity), decimal(0)) : null;
    return {
        ...base,
        quantity: Number(base.quantity),
        unitPrice: Number(base.unitPrice),
        inventoryValue: Number(decimal(base.quantity).mul(base.unitPrice)),
        receivedQuantity: received?.gt(0) && received.gte(base.quantity) ? Number(received) : null,
    };
};

const calculateStockMetrics = (balances = []) => {
    let currentStock = decimal(0);
    let inventoryValue = decimal(0);
    let activeLotCount = 0;

    for (const balance of balances) {
        const balanceQuantity = decimal(balance.quantity);
        currentStock = currentStock.add(balanceQuantity);
        inventoryValue = inventoryValue.add(balanceQuantity.mul(balance.unitPrice));
        if (balanceQuantity.gt(0)) activeLotCount += 1;
    }

    return {
        currentStock: Number(currentStock),
        inventoryValue: Number(inventoryValue),
        activeLotCount,
    };
};

/**
 * Convert Prisma decimals for JSON and derive stock value and alert state.
 * status is authoritative; isArchived is the compatibility alias for INACTIVE.
 */
const normalizeProduct = (product, { includeLots = false } = {}) => {
    const { inventoryBalances = [], ...baseProduct } = product;
    const metrics = calculateStockMetrics(inventoryBalances);
    const normalized = {
        ...baseProduct,
        imageUrls: baseProduct.imageUrls?.length ? baseProduct.imageUrls
            : baseProduct.imageUrl ? [baseProduct.imageUrl] : [],
        conversionQuantity:
            baseProduct.conversionQuantity == null
                ? null
                : Number(baseProduct.conversionQuantity),
        minAlertQuantity: Number(baseProduct.minAlertQuantity),
        ...metrics,
        isArchived: baseProduct.status === 'INACTIVE',
        isLowStock:
            decimal(baseProduct.minAlertQuantity).gt(0)
            && stockInAlertUnit(baseProduct, metrics.currentStock).lt(baseProduct.minAlertQuantity),
    };

    if (!includeLots) return normalized;
    return {
        ...normalized,
        lots: inventoryBalances.map(normalizeBalance),
    };
};

/**
 * Expose ledger quantities and related context without leaking the idempotency key.
 */
const normalizeTransaction = (transaction) => {
    const publicTransaction = { ...transaction };
    delete publicTransaction.idempotencyKey;
    return {
        ...publicTransaction,
        quantity: Number(transaction.quantity),
        totalAmount: Number(transaction.totalAmount),
        ...(transaction.inventoryBalance && {
            inventoryBalance: normalizeBalance(transaction.inventoryBalance),
        }),
        ...(transaction.season && {
            season: {
                id: transaction.season.id,
                name: transaction.season.name,
                pondName: transaction.season.pond?.name || null,
            },
        }),
    };
};

/**
 * Reject missing and foreign farms with the same not-found response.
 * Accept the transaction client so authorization participates in the calling write.
 */
const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: { id: farmId, ownerId, isDeleted: false },
        select: { id: true, ownerId: true, name: true },
    });
    if (!farm) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.FARM_NOT_FOUND);
    }
    return farm;
};

/**
 * Scope product reads to a non-deleted farm owned by the authenticated account.
 */
const findOwnedProduct = async (client, farmId, productId, ownerId, select = PRODUCT_SELECT) => {
    const product = await client.product.findFirst({
        where: {
            id: productId,
            farmId,
            isDeleted: false,
            farm: { ownerId, isDeleted: false },
        },
        select,
    });
    if (!product) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.PRODUCT_NOT_FOUND);
    }
    return product;
};

/**
 * Check normalized names for the same unit across non-deleted products.
 * Inactive products still reserve their name; callers perform writes serializably.
 */
const requireUniqueProductNameUnit = async (
    client,
    farmId,
    name,
    unit,
    excludedProductId,
) => {
    const products = await client.product.findMany({
        where: {
            farmId,
            unit,
            isDeleted: false,
            ...(excludedProductId && { id: { not: excludedProductId } }),
        },
        select: { name: true },
    });
    const nameKey = normalizeNameKey(name);
    if (products.some((product) => normalizeNameKey(product.name) === nameKey)) {
        throw new ApiError(
            httpStatus.CONFLICT,
            messages.INVENTORY.NAME_UNIT_ALREADY_EXISTS,
        );
    }
};

const requireActiveProduct = (product) => {
    if (product.status !== 'ACTIVE') {
        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.PRODUCT_ARCHIVED);
    }
    return product;
};

/**
 * Require both conversion fields for PACK/BOTTLE and reject them for other units.
 * Validate merged updates so a partial patch cannot bypass the conversion invariant.
 */
const validateConversion = ({ unit, conversionQuantity, conversionUnit }) => {
    const packaged = PACKAGED_UNITS.has(unit);
    const hasQuantity = conversionQuantity != null;
    const hasUnit = conversionUnit != null;
    if (packaged && (!hasQuantity || !hasUnit)) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            'PACK và BOTTLE bắt buộc phải có số lượng và đơn vị quy đổi',
        );
    }
    if (!packaged && (hasQuantity || hasUnit)) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Thông tin quy đổi chỉ áp dụng cho PACK và BOTTLE',
        );
    }
};

/**
 * Translate duplicate names, lots, idempotency keys and serialization failures to conflicts.
 * Preserve business errors and let unexpected failures reach the global error handler.
 */
const mapWriteError = (error) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002') {
        const target = JSON.stringify(error.meta?.target || '');
        if (target.includes('idempotency')) {
            throw new ApiError(
                httpStatus.CONFLICT,
                messages.INVENTORY.IDEMPOTENCY_KEY_CONFLICT,
            );
        }
        if (target.includes('lot')) {
            throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.LOT_ALREADY_EXISTS);
        }
        throw new ApiError(
            httpStatus.CONFLICT,
            messages.INVENTORY.NAME_UNIT_ALREADY_EXISTS,
        );
    }
    if (error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
    }
    throw error;
};

const productWithBalancesSelect = {
    ...PRODUCT_SELECT,
    inventoryBalances: {
        where: { quantity: { gt: 0 } },
        select: BALANCE_SELECT,
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    },
};

/**
 * Read the owned farm catalog and filter low stock after applying unit conversions.
 * Paginate the filtered results; summary totals cover all active products in the farm.
 */
const getProducts = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const { page, limit, search, category, stockStatus, archiveStatus } = query;
    const archiveWhere = archiveStatus === PRODUCT_ARCHIVE_STATUS.ALL
        ? {}
        : {
            status: archiveStatus === PRODUCT_ARCHIVE_STATUS.ARCHIVED
                ? 'INACTIVE'
                : 'ACTIVE',
        };
    const baseWhere = { farmId, status: 'ACTIVE', isDeleted: false };
    const filteredWhere = {
        farmId,
        isDeleted: false,
        ...archiveWhere,
        ...(search && { name: { contains: search, mode: 'insensitive' } }),
        ...(category && { category }),
    };

    const [candidates, allProducts] = await Promise.all([
        prisma.product.findMany({
            where: filteredWhere,
            select: productWithBalancesSelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.product.findMany({
            where: baseWhere,
            select: productWithBalancesSelect,
        }),
    ]);

    const normalizedCandidates = candidates.map((product) => normalizeProduct(product));
    const filteredProducts = stockStatus === PRODUCT_STOCK_STATUS.LOW
        ? normalizedCandidates.filter((product) => product.isLowStock)
        : normalizedCandidates;
    const totalResults = filteredProducts.length;
    const products = filteredProducts.slice((page - 1) * limit, page * limit);

    const allNormalized = allProducts.map((product) => normalizeProduct(product));
    return {
        products,
        meta: {
            page,
            limit,
            totalResults,
            totalPages: Math.ceil(totalResults / limit),
            hasNextPage: page * limit < totalResults,
            summary: {
                totalProducts: allNormalized.length,
                lowStockCount: allNormalized.filter((product) => product.isLowStock).length,
                inventoryValue: allNormalized.reduce(
                    (total, product) => total + product.inventoryValue,
                    0,
                ),
            },
        },
    };
};

/**
 * Read all lots of an owned product, including exhausted lots for historical context.
 * canArchive is a UI hint; pause writes recheck stock and planned schedules transactionally.
 */
const getProduct = async (farmId, productId, ownerId) => {
    const product = await findOwnedProduct(
        prisma,
        farmId,
        productId,
        ownerId,
        {
            ...productWithBalancesSelect,
            inventoryBalances: {
                select: {
                    ...BALANCE_SELECT,
                    transactions: {
                        where: { transactionType: { in: [INVENTORY_TRANSACTION_TYPE.STOCK_IN, INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN] } },
                        select: { quantity: true },
                    },
                },
                orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            },
            farm: { select: { id: true, name: true } },
        },
    );
    const plannedUseCount = await prisma.operationSchedule.count({
        where: { productId, status: 'PLANNED' },
    });
    const normalized = normalizeProduct(product, { includeLots: true });
    return {
        ...normalized,
        plannedUseCount,
        canArchive:
            !normalized.isArchived
            && normalized.currentStock === 0
            && plannedUseCount === 0,
    };
};

/**
 * Keep the legacy cover image in sync with imageUrls and normalize nullable fields.
 * Omitted patch fields remain untouched unless creation requests default values.
 */
const prepareProductData = (productData, { fillDefaults = false } = {}) => ({
    ...productData,
    ...((Object.hasOwn(productData, 'imageUrls') || Object.hasOwn(productData, 'imageUrl') || fillDefaults) && {
        imageUrls: productData.imageUrls ?? (productData.imageUrl ? [productData.imageUrl] : []),
        imageUrl: productData.imageUrls ? productData.imageUrls[0] ?? null : productData.imageUrl ?? null,
    }),
    ...((fillDefaults || Object.hasOwn(productData, 'description')) && {
        description: productData.description || null,
    }),
    ...((fillDefaults || Object.hasOwn(productData, 'conversionQuantity')) && {
        conversionQuantity: productData.conversionQuantity ?? null,
    }),
    ...((fillDefaults || Object.hasOwn(productData, 'conversionUnit')) && {
        conversionUnit: productData.conversionUnit ?? null,
    }),
});

/**
 * Create a product after checking farm ownership and name/unit uniqueness.
 * Keep the checks and insert in one serializable transaction.
 */
const createProduct = async (farmId, productData, ownerId) => {
    const data = prepareProductData(productData, { fillDefaults: true });
    validateConversion(data);
    try {
        const product = await prisma.$transaction(
            async (transaction) => {
                await requireOwnedFarm(transaction, farmId, ownerId);
                await requireUniqueProductNameUnit(
                    transaction,
                    farmId,
                    data.name,
                    data.unit,
                );
                return transaction.product.create({
                    data: { ...data, farmId },
                    select: PRODUCT_SELECT,
                });
            },
            { isolationLevel: 'Serializable' },
        );
        return normalizeProduct({ ...product, inventoryBalances: [] });
    } catch (error) {
        return mapWriteError(error);
    }
};

const productFieldChanged = (current, next, field) => {
    if (!Object.hasOwn(next, field)) return false;
    if (field === 'conversionQuantity') {
        return !decimalEqual(current[field], next[field]);
    }
    return current[field] !== next[field];
};

/**
 * Update only an active owned product and reject stale version tokens.
 * Existing ledger entries lock units and conversion fields; checks and writes are serializable.
 */
const updateProduct = async (farmId, productId, productData, ownerId) => {
    const { expectedUpdatedAt, ...requestedData } = productData;
    try {
        const product = await prisma.$transaction(
            async (transaction) => {
                await requireOwnedFarm(transaction, farmId, ownerId);
                const current = await findOwnedProduct(
                    transaction,
                    farmId,
                    productId,
                    ownerId,
                );
                requireActiveProduct(current);
                const merged = prepareProductData({ ...current, ...requestedData });
                validateConversion(merged);

                const changesLockedField = UNIT_LOCKED_FIELDS.some((field) =>
                    productFieldChanged(current, requestedData, field));
                if (changesLockedField) {
                    const transactionCount = await transaction.inventoryTransaction.count({
                        where: { productId },
                    });
                    if (transactionCount > 0) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.INVENTORY.UNIT_LOCKED,
                        );
                    }
                }

                if (requestedData.name !== undefined || requestedData.unit !== undefined) {
                    await requireUniqueProductNameUnit(
                        transaction,
                        farmId,
                        merged.name,
                        merged.unit,
                        productId,
                    );
                }

                const updateData = prepareProductData(requestedData);
                const result = await transaction.product.updateMany({
                    where: {
                        id: productId,
                        farmId,
                        isDeleted: false,
                        updatedAt: versionRange(expectedUpdatedAt),
                    },
                    data: { ...updateData, updatedAt: new Date() },
                });
                if (result.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
                }
                return transaction.product.findUnique({
                    where: { id: productId },
                    select: productWithBalancesSelect,
                });
            },
            { isolationLevel: 'Serializable' },
        );
        return normalizeProduct(product);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Pause an active owned product only when no stock or planned use remains.
 * Update status and archivedAt together; a version predicate rejects racing edits.
 */
const archiveProduct = async (farmId, productId, ownerId) => {
    try {
        const product = await prisma.$transaction(
            async (transaction) => {
                await requireOwnedFarm(transaction, farmId, ownerId);
                const current = await findOwnedProduct(
                    transaction,
                    farmId,
                    productId,
                    ownerId,
                );
                requireActiveProduct(current);
                const [stock, plannedUseCount] = await Promise.all([
                    transaction.inventoryBalance.aggregate({
                        where: { productId },
                        _sum: { quantity: true },
                    }),
                    transaction.operationSchedule.count({
                        where: { productId, status: 'PLANNED' },
                    }),
                ]);
                if (decimal(stock._sum.quantity).gt(0)) {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.INVENTORY.STOCK_REMAINS,
                    );
                }
                if (plannedUseCount > 0) {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.INVENTORY.PLANNED_USE_EXISTS,
                    );
                }

                const changedAt = new Date();
                const result = await transaction.product.updateMany({
                    where: {
                        id: productId,
                        farmId,
                        isDeleted: false,
                        status: 'ACTIVE',
                        updatedAt: versionRange(current.updatedAt),
                    },
                    data: {
                        status: 'INACTIVE',
                        archivedAt: changedAt,
                        updatedAt: changedAt,
                    },
                });
                if (result.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
                }
                return transaction.product.findUnique({
                    where: { id: productId },
                    select: PRODUCT_SELECT,
                });
            },
            { isolationLevel: 'Serializable' },
        );
        return normalizeProduct({ ...product, inventoryBalances: [] });
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Resume an inactive owned product after rechecking name/unit uniqueness.
 * Clear archivedAt and update status in the same version-checked transaction.
 */
const restoreProduct = async (farmId, productId, ownerId) => {
    try {
        const product = await prisma.$transaction(
            async (transaction) => {
                await requireOwnedFarm(transaction, farmId, ownerId);
                const current = await findOwnedProduct(
                    transaction,
                    farmId,
                    productId,
                    ownerId,
                );
                if (current.status !== 'INACTIVE') {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.INVENTORY.PRODUCT_NOT_ARCHIVED,
                    );
                }
                await requireUniqueProductNameUnit(
                    transaction,
                    farmId,
                    current.name,
                    current.unit,
                    productId,
                );

                const updatedAt = new Date();
                const result = await transaction.product.updateMany({
                    where: {
                        id: productId,
                        farmId,
                        isDeleted: false,
                        status: 'INACTIVE',
                        updatedAt: versionRange(current.updatedAt),
                    },
                    data: { status: 'ACTIVE', archivedAt: null, updatedAt },
                });
                if (result.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
                }
                return transaction.product.findUnique({
                    where: { id: productId },
                    select: PRODUCT_SELECT,
                });
            },
            { isolationLevel: 'Serializable' },
        );
        return normalizeProduct({ ...product, inventoryBalances: [] });
    } catch (error) {
        return mapWriteError(error);
    }
};

const getProductStock = async (client, productId) => {
    const stock = await client.inventoryBalance.aggregate({
        where: { productId },
        _sum: { quantity: true },
    });
    return decimal(stock._sum.quantity);
};

const findIdempotentTransaction = (client, idempotencyKey) =>
    client.inventoryTransaction.findUnique({
        where: { idempotencyKey },
        select: {
            ...TRANSACTION_SELECT,
            inventoryBalance: { select: BALANCE_SELECT },
            product: {
                select: {
                    id: true,
                    farmId: true,
                    farm: { select: { ownerId: true } },
                },
            },
        },
    });

const nullableTextEqual = (left, right) => (left || null) === (right || null);
const dateEqual = (left, right) => new Date(left).getTime() === new Date(right).getTime();

/**
 * Accept a replay only for the same owner, farm, product and movement payload.
 * Receipt comparisons also cover lot, date, unit price and supplier identity.
 */
const idempotentTransactionMatches = (existing, farmId, productId, ownerId, data) => {
    if (
        existing.productId !== productId
        || existing.product.farmId !== farmId
        || existing.product.farm.ownerId !== ownerId
        || existing.transactionType !== data.transactionType
        || !decimalEqual(existing.quantity, data.quantity)
    ) {
        return false;
    }
    if (data.transactionType === INVENTORY_TRANSACTION_TYPE.STOCK_IN) {
        return (
            normalizeNameKey(existing.inventoryBalance.lotNumber)
                === normalizeNameKey(data.lotNumber)
            && dateEqual(existing.inventoryBalance.receivedAt, data.receivedAt)
            && decimalEqual(existing.inventoryBalance.unitPrice, data.unitPrice)
            && (data.supplierId
                ? existing.inventoryBalance.supplierId === data.supplierId
                : !existing.inventoryBalance.supplierId
                    && normalizeNameKey(existing.inventoryBalance.supplierName)
                        === normalizeNameKey(data.supplierName))
            && nullableTextEqual(existing.reason, data.reason)
        );
    }
    return existing.inventoryBalanceId === data.inventoryBalanceId
        && nullableTextEqual(existing.reason, data.reason);
};

const isIdempotencyUniqueError = (error) =>
    error?.code === 'P2002'
    && JSON.stringify(error.meta?.target || '').includes('idempotency');

const buildReplayResult = async (client, existing) => {
    const existingTransaction = { ...existing };
    delete existingTransaction.product;
    return {
        transaction: normalizeTransaction(existingTransaction),
        balance: normalizeBalance(existing.inventoryBalance),
        currentStock: Number(await getProductStock(client, existing.productId)),
        idempotentReplay: true,
    };
};

/**
 * Commit the lot change, ledger entry and low-stock notification atomically.
 * Matching retries replay the saved movement; mismatched keys and insufficient stock conflict.
 * Emit the socket event only after the serializable transaction commits.
 */
const recordStockTransaction = async (
    farmId,
    productId,
    transactionData,
    ownerId,
    idempotencyKey,
) => {
    let notificationToEmit = null;
    if (!OWNER_INVENTORY_TRANSACTION_TYPES.includes(transactionData.transactionType)) {
        throw new ApiError(httpStatus.FORBIDDEN, messages.AUTH.FORBIDDEN);
    }
    if (
        [INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN, INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT]
            .includes(transactionData.transactionType)
        && !transactionData.reason?.trim()
    ) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            messages.INVENTORY.ADJUSTMENT_REASON_REQUIRED,
        );
    }
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
                const existing = await findIdempotentTransaction(transaction, idempotencyKey);
                if (existing) {
                    if (!idempotentTransactionMatches(
                        existing,
                        farmId,
                        productId,
                        ownerId,
                        transactionData,
                    )) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.INVENTORY.IDEMPOTENCY_KEY_CONFLICT,
                        );
                    }
                    return buildReplayResult(transaction, existing);
                }

                await requireOwnedFarm(transaction, farmId, ownerId);
                const product = await findOwnedProduct(
                    transaction,
                    farmId,
                    productId,
                    ownerId,
                );
                requireActiveProduct(product);
                const previousStock = await getProductStock(transaction, productId);
                const movementQuantity = decimal(transactionData.quantity);
                let balance;
                let totalAmount;

                if (transactionData.transactionType === INVENTORY_TRANSACTION_TYPE.STOCK_IN) {
                    let supplierName = transactionData.supplierName;
                    if (transactionData.supplierId) {
                        const supplier = await transaction.supplier.findFirst({
                            where: {
                                id: transactionData.supplierId,
                                farm: { ownerId },
                                isDeleted: false,
                                isActive: true,
                            },
                            select: { name: true },
                        });
                        if (!supplier) {
                            throw new ApiError(httpStatus.NOT_FOUND, messages.SUPPLIER.NOT_FOUND);
                        }
                        supplierName = supplier.name;
                    }
                    totalAmount = calculateTransactionAmount(
                        movementQuantity,
                        transactionData.unitPrice,
                    );
                    const duplicateLot = await transaction.inventoryBalance.findFirst({
                        where: {
                            productId,
                            lotNumber: { equals: transactionData.lotNumber, mode: 'insensitive' },
                        },
                        select: { id: true },
                    });
                    if (duplicateLot) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.INVENTORY.LOT_ALREADY_EXISTS,
                        );
                    }
                    balance = await transaction.inventoryBalance.create({
                        data: {
                            productId,
                            lotNumber: transactionData.lotNumber,
                            receivedAt: transactionData.receivedAt,
                            quantity: movementQuantity,
                            unitPrice: decimal(transactionData.unitPrice),
                            supplierName,
                            ...(transactionData.supplierId && {
                                supplierId: transactionData.supplierId,
                            }),
                        },
                        select: BALANCE_SELECT,
                    });
                } else {
                    const currentBalance = await transaction.inventoryBalance.findFirst({
                        where: {
                            id: transactionData.inventoryBalanceId,
                            productId,
                        },
                        select: BALANCE_SELECT,
                    });
                    if (!currentBalance) {
                        throw new ApiError(
                            httpStatus.NOT_FOUND,
                            messages.INVENTORY.BALANCE_NOT_FOUND,
                        );
                    }
                    const isDecrease = [INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT, INVENTORY_TRANSACTION_TYPE.STOCK_OUT]
                        .includes(transactionData.transactionType);
                    if (isDecrease && decimal(currentBalance.quantity).lt(movementQuantity)) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.INVENTORY.INSUFFICIENT_STOCK,
                        );
                    }
                    if (!isDecrease && decimal(currentBalance.quantity)
                        .add(movementQuantity).gt(INVENTORY_LIMITS.MAX_BALANCE_QUANTITY)) {
                        throw new ApiError(
                            httpStatus.BAD_REQUEST,
                            messages.INVENTORY.BALANCE_LIMIT_EXCEEDED,
                        );
                    }
                    totalAmount = calculateTransactionAmount(
                        movementQuantity,
                        currentBalance.unitPrice,
                    );

                    const balanceUpdate = await transaction.inventoryBalance.updateMany({
                        where: {
                            id: currentBalance.id,
                            productId,
                            // PostgreSQL timestamps may contain microseconds lost by JS Date.
                            // Compare the exact decimal balance; Serializable protects concurrent edits.
                            quantity: {
                                equals: currentBalance.quantity,
                                ...(isDecrease && { gte: movementQuantity }),
                            },
                        },
                        data: {
                            quantity: isDecrease
                                ? { decrement: movementQuantity }
                                : { increment: movementQuantity },
                            updatedAt: new Date(),
                        },
                    });
                    if (balanceUpdate.count !== 1) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.INVENTORY.CHANGE_CONFLICT,
                        );
                    }
                    balance = await transaction.inventoryBalance.findUnique({
                        where: { id: currentBalance.id },
                        select: BALANCE_SELECT,
                    });
                }

                const inventoryTransaction = await transaction.inventoryTransaction.create({
                    data: {
                        transactionGroupId: randomUUID(),
                        productId,
                        inventoryBalanceId: balance.id,
                        transactionType: transactionData.transactionType,
                        quantity: movementQuantity,
                        unitSnapshot: product.unit,
                        totalAmount,
                        reason: transactionData.reason || null,
                        performedBy: ownerId,
                        idempotencyKey,
                    },
                    select: TRANSACTION_SELECT,
                });

                const currentStock = await getProductStock(transaction, productId);
                const threshold = decimal(product.minAlertQuantity);
                const previousAlertStock = stockInAlertUnit(product, previousStock);
                const currentAlertStock = stockInAlertUnit(product, currentStock);
                const crossedLowStockThreshold = threshold.gt(0)
                    && previousAlertStock.gte(threshold)
                    && currentAlertStock.lt(threshold);
                if (crossedLowStockThreshold) {
                    const notification = await transaction.notification.create({
                        data: {
                            accountId: ownerId,
                            title: messages.INVENTORY.LOW_STOCK_TITLE,
                            content:
                                `${product.name} còn ${currentAlertStock.toString()} ${alertUnit(product)}, `
                                + `thấp hơn ngưỡng ${threshold.toString()} ${alertUnit(product)}.`,
                            type: NOTIFICATION_TYPE.INVENTORY_LOW,
                            referenceType: 'PRODUCT',
                            referenceId: productId,
                        },
                        select: { id: true, accountId: true },
                    });
                    notificationToEmit = notification;
                }

                return {
                    transaction: normalizeTransaction(inventoryTransaction),
                    balance: normalizeBalance(balance),
                    currentStock: Number(currentStock),
                    idempotentReplay: false,
                };
            },
            { isolationLevel: 'Serializable' },
        );

        if (notificationToEmit) {
            emitNotification(notificationToEmit.accountId, 'notification:new', {
                id: notificationToEmit.id,
            });
        }
        return result;
    } catch (error) {
        if (isIdempotencyUniqueError(error)) {
            const existing = await findIdempotentTransaction(prisma, idempotencyKey);
            if (
                existing
                && idempotentTransactionMatches(
                    existing,
                    farmId,
                    productId,
                    ownerId,
                    transactionData,
                )
            ) {
                return buildReplayResult(prisma, existing);
            }
        }
        return mapWriteError(error);
    }
};

const HISTORY_SELECT = {
    ...TRANSACTION_SELECT,
    product: {
        select: { id: true, name: true, category: true, unit: true, isDeleted: true },
    },
    inventoryBalance: { select: BALANCE_SELECT },
    season: { select: { id: true, name: true, pond: { select: { name: true } } } },
    performer: { select: { id: true, fullName: true, email: true } },
};

/**
 * Read the owned farm ledger with validated filters and a scoped pagination cursor.
 * Preserve historical products; value totals use the full filtered set, not just the current page.
 */
const getInventoryHistory = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const {
        cursor,
        limit,
        productId,
        transactionType,
        seasonId,
        referenceType,
        referenceId,
        createdFrom,
        createdTo,
    } = query;
    const where = {
        product: { farmId },
        ...(productId && { productId }),
        ...(transactionType && { transactionType }),
        ...(seasonId && { seasonId }),
        ...(referenceType && { referenceType, referenceId }),
        ...((createdFrom || createdTo) && {
            createdAt: {
                ...(createdFrom && { gte: createdFrom }),
                ...(createdTo && { lte: createdTo }),
            },
        }),
    };

    if (cursor) {
        const cursorTransaction = await prisma.inventoryTransaction.findFirst({
            where: { ...where, id: cursor },
            select: { id: true },
        });
        if (!cursorTransaction) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.INVENTORY.INVALID_CURSOR);
        }
    }

    const [rows, totalResults, inbound, outbound] = await Promise.all([
        prisma.inventoryTransaction.findMany({
            where,
            select: HISTORY_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        }),
        prisma.inventoryTransaction.count({ where }),
        prisma.inventoryTransaction.aggregate({
            where: {
                AND: [
                    where,
                    {
                        transactionType: {
                            in: [
                                INVENTORY_TRANSACTION_TYPE.STOCK_IN,
                                INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN,
                            ],
                        },
                    },
                ],
            },
            _sum: { totalAmount: true },
        }),
        prisma.inventoryTransaction.aggregate({
            where: {
                AND: [
                    where,
                    {
                        transactionType: {
                            in: [
                                INVENTORY_TRANSACTION_TYPE.STOCK_OUT,
                                INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT,
                            ],
                        },
                    },
                ],
            },
            _sum: { totalAmount: true },
        }),
    ]);
    const hasNextPage = rows.length > limit;
    const transactions = (hasNextPage ? rows.slice(0, limit) : rows)
        .map(normalizeTransaction);

    return {
        transactions,
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? transactions[transactions.length - 1].id : null,
            summary: {
                totalInboundValue: Number(inbound._sum.totalAmount || 0),
                totalOutboundValue: Number(outbound._sum.totalAmount || 0),
            },
        },
    };
};

module.exports = {
    getProducts,
    getProduct,
    createProduct,
    updateProduct,
    archiveProduct,
    restoreProduct,
    recordStockTransaction,
    getInventoryHistory,
};
