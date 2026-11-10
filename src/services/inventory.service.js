const { randomUUID, createHash } = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const {
    ApiError,
    requireCompleteInventoryProduct,
    isInventoryProductReviewable,
    checkIngredients,
} = require('../utils');
const {
    httpStatus,
    messages,
    PRODUCT_UNIT,
    BOTTLE_CONVERSION_UNITS,
    PRODUCT_STOCK_STATUS,
    PRODUCT_ARCHIVE_STATUS,
    PRODUCT_STATUS,
    OPERATION_STATUS,
    PROTOCOL_STATUS,
    INVENTORY_TRANSACTION_TYPE,
    OWNER_INVENTORY_TRANSACTION_TYPES,
    NOTIFICATION_TYPE,
    INVENTORY_LIMITS,
    PRODUCT_COMPLIANCE_STATUS,
    ACCOUNT_STATUS,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    SCHEDULE_CANCELLATION_TYPE,
} = require('../constants');
const { emitNotification } = require('../realtime');
const { requireSelectableSupplier } = require('./supplier.service');
const legacyRead = require('./inventoryLegacyRead.service');
const { getHistoryOptions } = require('./inventoryHistoryOptions.service');

const PACKAGED_UNITS = new Set([PRODUCT_UNIT.PACK, PRODUCT_UNIT.BOTTLE]);
const UNIT_LOCKED_FIELDS = ['unit', 'conversionQuantity', 'conversionUnit'];
const COMPLIANCE_FACT_FIELDS = [
    'regulatoryType', 'registrationNumber', 'ingredientsText', 'containsAntibiotic',
    'usageInstructions', 'withdrawalDays', 'evidenceUrls',
];

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
    manufacturerId: true,
    manufacturer: {
        select: {
            id: true,
            name: true,
            status: true,
            supplierType: true,
        },
    },
    compliance: true,
    _count: {
        select: {
            inventoryTransactions: true,
            inventoryBalances: true,
            schedules: true,
            executions: true,
            protocolItems: { where: { protocol: { status: { not: PROTOCOL_STATUS.DRAFT } } } },
        },
    },
    imageUrls: true,
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
    supplierNameSnapshot: true,
    expiryDate: true,
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
const versionRange = (date) => ({
    gte: date,
    lt: new Date(date.getTime() + 1),
});

const normalizeBalance = (balance) => {
    const { transactions, ...base } = balance;
    const received = Array.isArray(transactions) && transactions.length
        ? transactions.reduce((total, row) => total.add(row.quantity), decimal(0)) : null;
    return {
        ...base,
        supplierName: base.supplierNameSnapshot,
        quantityExact: base.quantity.toFixed(),
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
        if (balanceQuantity.gt(0)) {
            activeLotCount += 1;
        }
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
    const { inventoryBalances = [], _count, ...baseProduct } = product;
    const metrics = calculateStockMetrics(inventoryBalances);
    const normalized = {
        ...baseProduct,
        schemaVersion: 2,
        requiresManufacturer: baseProduct.manufacturerId == null,
        readOnly: false,
        imageUrls: baseProduct.imageUrls || [],
        imageUrl: baseProduct.imageUrls?.[0] || null,
        metadataLocked: baseProduct.metadataLocked
            ?? Object.values(_count || {}).some((count) => count > 0),
        compliance: baseProduct.compliance && {
            ...baseProduct.compliance,
            withdrawalDays: baseProduct.compliance.withdrawalDays == null ? null : Number(baseProduct.compliance.withdrawalDays),
        },
        substanceCheck: checkIngredients(baseProduct.compliance?.ingredientsText),
        conversionQuantity:
            baseProduct.conversionQuantity == null
                ? null
                : Number(baseProduct.conversionQuantity),
        minAlertQuantity: Number(baseProduct.minAlertQuantity),
        ...metrics,
        isArchived: baseProduct.status === PRODUCT_STATUS.INACTIVE,
        isLowStock:
            decimal(baseProduct.minAlertQuantity).gt(0)
            && stockInAlertUnit(baseProduct, metrics.currentStock).lt(baseProduct.minAlertQuantity),
    };

    if (!includeLots) {
        return normalized;
    }
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
        quantityExact: transaction.quantity.toFixed(),
        quantity: Number(transaction.quantity),
        ...(transaction.product && { product: { ...transaction.product } }),
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
        where: {
            id: farmId,
            ownerId,
        },
        select: {
            id: true,
            ownerId: true,
            name: true,
        },
    });
    if (!farm) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.FARM_NOT_FOUND);
    }
    return farm;
};

/**
 * Scope product reads to the farm owned by the authenticated account.
 */
const findOwnedProduct = async (client, farmId, productId, ownerId, select = PRODUCT_SELECT) => {
    const product = await client.product.findFirst({
        where: {
            id: productId,
            farmId,
            farm: { ownerId },
        },
        select,
    });
    if (!product) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.PRODUCT_NOT_FOUND);
    }
    return product;
};

/**
 * Check normalized names for the same unit across active and inactive products.
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
    if (product.status !== PRODUCT_STATUS.ACTIVE) {
        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.PRODUCT_ARCHIVED);
    }
    return product;
};

/**
 * Require both conversion fields for PACK/BOTTLE and reject them for other units.
 * Validate merged updates so a partial patch cannot bypass the conversion invariant.
 */
const validateConversion = ({
    unit, conversionQuantity, conversionUnit,
}, { enforceBottleUnit = true } = {}) => {
    const packaged = PACKAGED_UNITS.has(unit);
    const hasQuantity = conversionQuantity != null;
    const hasUnit = conversionUnit != null;
    if (packaged && (!hasQuantity || !hasUnit)) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            messages.INVENTORY.CONVERSION_REQUIRED,
        );
    }
    if (!packaged && (hasQuantity || hasUnit)) {
        throw new ApiError(
            httpStatus.BAD_REQUEST,
            messages.INVENTORY.CONVERSION_NOT_ALLOWED,
        );
    }
    if (enforceBottleUnit && unit === PRODUCT_UNIT.BOTTLE && !BOTTLE_CONVERSION_UNITS.includes(conversionUnit)) {
        throw ApiError.badRequest(messages.INVENTORY.BOTTLE_CONVERSION_UNIT);
    }
};

/**
 * Translate duplicate names, lots, idempotency keys and serialization failures to conflicts.
 * Preserve business errors and let unexpected failures reach the global error handler.
 */
const mapWriteError = (error) => {
    if (error instanceof ApiError) {
        throw error;
    }
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
    if (error.code === 'P2003') {
        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.HAS_REFERENCES);
    }
    if (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code))) {
        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
    }
    throw error;
};

const productWithBalancesSelect = {
    ...PRODUCT_SELECT,
    inventoryBalances: {
        where: { quantity: { gt: 0 } },
        select: BALANCE_SELECT,
        orderBy: [{
            expiryDate: {
                sort: 'asc',
                nulls: 'last',
            },
        }, { receivedAt: 'asc' }, { id: 'asc' }],
    },
};

/**
 * Read the owned farm catalog and filter low stock after applying unit conversions.
 * Paginate the filtered results; summary totals cover all active products in the farm.
 */
const getProducts = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const {
        page, limit, search, category, stockStatus, archiveStatus,
    } = query;
    const archiveWhere = archiveStatus === PRODUCT_ARCHIVE_STATUS.ALL
        ? {}
        : {
            status: archiveStatus === PRODUCT_ARCHIVE_STATUS.ARCHIVED
                ? PRODUCT_STATUS.INACTIVE
                : PRODUCT_STATUS.ACTIVE,
        };
    const baseWhere = {
        farmId,
        status: PRODUCT_STATUS.ACTIVE,
    };
    const filteredWhere = {
        farmId,
        ...archiveWhere,
        ...(search && {
            name: {
                contains: search,
                mode: 'insensitive',
            },
        }),
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
 * Pausing is allowed with stock and planned schedules; their history is retained.
 */
const getProduct = async (farmId, productId, ownerId) => {
    const product = await findOwnedProduct(prisma, farmId, productId, ownerId, {
        ...PRODUCT_SELECT,
        inventoryBalances: {
            select: {
                ...BALANCE_SELECT,
                transactions: {
                    where: { transactionType: { in: [INVENTORY_TRANSACTION_TYPE.STOCK_IN, INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN] } },
                    select: { quantity: true },
                },
            },
            orderBy: [{
                expiryDate: {
                    sort: 'asc',
                    nulls: 'last',
                },
            }, { receivedAt: 'asc' }, { id: 'asc' }],
        },
        farm: {
            select: {
                id: true,
                name: true,
            },
        },
    });
    const [plannedUseCount, used, deletion] = await Promise.all([
        prisma.operationSchedule.count({
            where: {
                productId,
                status: OPERATION_STATUS.PLANNED,
            },
        }),
        hasProductUsage(prisma, productId),
        productDeletionImpact(prisma, product),
    ]);
    return {
        ...normalizeProduct({
            ...product,
            metadataLocked: used,
        }, { includeLots: true }),
        plannedUseCount,
        canArchive: product.status === PRODUCT_STATUS.ACTIVE,
        canDelete: deletion.allowed,
        deletionConfirmationToken: deletion.token,
        deletionConfirmationMessage: deletion.message,
    };
};

/**
 * Keep the legacy cover image in sync with imageUrls and normalize nullable fields.
 * Omitted patch fields remain untouched unless creation requests default values.
 */
const prepareProductData = ({ imageUrl, ...productData }, { fillDefaults = false } = {}) => ({
    ...productData,
    ...((Object.hasOwn(productData, 'imageUrls') || imageUrl !== undefined || fillDefaults) && {
        imageUrls: productData.imageUrls ?? (imageUrl ? [imageUrl] : []),
    }),
    ...((fillDefaults || Object.hasOwn(productData, 'description')) && { description: productData.description || null }),
    ...((fillDefaults || Object.hasOwn(productData, 'conversionQuantity')) && { conversionQuantity: productData.conversionQuantity ?? null }),
    ...((fillDefaults || Object.hasOwn(productData, 'conversionUnit')) && { conversionUnit: productData.conversionUnit ?? null }),
});

/**
 * Owner saves require complete label facts and photos, never a client-supplied status.
 * A manual block survives ordinary edits until an Admin explicitly lifts it.
 */
const prepareOwnerCompliance = (product, requested, ownerId, checkedAt, current = null, photosChanged = false) => {
    const facts = Object.fromEntries(COMPLIANCE_FACT_FIELDS
        .filter((field) => Object.hasOwn(current || {}, field))
        .map((field) => [field, current[field]]));
    for (const field of COMPLIANCE_FACT_FIELDS) {
        if (Object.hasOwn(requested || {}, field)) facts[field] = requested[field];
    }
    if (photosChanged && !Object.hasOwn(requested || {}, 'evidenceUrls')) {
        facts.evidenceUrls = product.imageUrls || [];
    } else if (!facts.evidenceUrls?.length) {
        facts.evidenceUrls = product.imageUrls || [];
    }
    requireCompleteInventoryProduct({ ...product, compliance: facts });
    const manuallyBlocked = current?.complianceStatus === PRODUCT_COMPLIANCE_STATUS.BLOCKED
        && !current.reviewNote?.startsWith('AUTO_SUBSTANCE_BLOCK:');
    if (manuallyBlocked) {
        return {
            ...facts,
            complianceStatus: PRODUCT_COMPLIANCE_STATUS.BLOCKED,
            checkedBy: current.checkedBy,
            checkedAt: current.checkedAt,
            reviewNote: current.reviewNote,
            updatedAt: checkedAt,
        };
    }
    const ready = isInventoryProductReviewable({ ...product, compliance: facts });
    return {
        ...facts,
        complianceStatus: ready ? PRODUCT_COMPLIANCE_STATUS.REVIEWED : PRODUCT_COMPLIANCE_STATUS.DRAFT,
        checkedBy: ready ? ownerId : null,
        checkedAt: ready ? checkedAt : null,
        reviewNote: ready ? messages.INVENTORY.AUTO_REVIEW_NOTE : null,
        updatedAt: checkedAt,
    };
};

/**
 * Create a product after checking farm ownership and name/unit uniqueness.
 * Keep the checks and insert in one serializable transaction.
 */
const createProduct = async (farmId, productData, ownerId) => {
    const { compliance = {}, ...fields } = productData;
    const data = prepareProductData(fields, { fillDefaults: true });
    validateConversion(data);
    try {
        const product = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId);
            await requireSelectableSupplier(transaction, ownerId, data.manufacturerId, true);
            await requireUniqueProductNameUnit(transaction, farmId, data.name, data.unit);
            return transaction.product.create({
                data: {
                    ...data,
                    farmId,
                    compliance: {
                        create: prepareOwnerCompliance(data, compliance, ownerId, new Date()),
                    },
                },
                select: PRODUCT_SELECT,
            });
        }, { isolationLevel: 'Serializable' });
        return normalizeProduct({
            ...product,
            inventoryBalances: [],
        });
    } catch (error) {
        return mapWriteError(error);
    }
};

const productFieldChanged = (current, next, field) => {
    if (!Object.hasOwn(next, field)) {
        return false;
    }
    if (field === 'imageUrls') {
        return JSON.stringify(current.imageUrls) !== JSON.stringify(next.imageUrls);
    }
    if (field === 'conversionQuantity') {
        return !decimalEqual(current[field], next[field]);
    }
    return current[field] !== next[field];
};

/**
 * Update only an active owned product and reject stale version tokens.
 * Orders or stock history lock identity and compliance; only threshold and description remain editable.
 * Reference checks and writes share the serializable transaction and product row lock.
 */
const updateProduct = async (farmId, productId, productData, ownerId) => {
    const {
        expectedUpdatedAt, compliance, ...fields
    } = productData;
    if (Object.hasOwn(fields, 'imageUrl') && Object.hasOwn(fields, 'imageUrls')) {
        throw ApiError.badRequest(messages.INVENTORY.IMAGE_FIELDS_CONFLICT);
    }
    // Normalize aliases before merging so validation and both writes see the same label.
    const requestedData = prepareProductData(fields);
    try {
        const product = await prisma.$transaction(
            async (transaction) => {
                await requireOwnedFarm(transaction, farmId, ownerId);
                await transaction.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
                const current = await findOwnedProduct(
                    transaction,
                    farmId,
                    productId,
                    ownerId,
                );
                requireActiveProduct(current);
                const merged = {
                    ...current,
                    ...requestedData,
                };
                // Unrelated edits must not reinterpret a legacy product's stored conversion.
                validateConversion(merged, {
                    enforceBottleUnit: UNIT_LOCKED_FIELDS.some((field) => Object.hasOwn(requestedData, field)),
                });

                const used = await hasProductUsage(transaction, productId);
                const identityFields = [
                    'name', 'category', 'manufacturerId', 'imageUrls',
                    'recommendationReason', ...UNIT_LOCKED_FIELDS,
                ];
                const identityChanged = identityFields.some((field) => productFieldChanged(current, requestedData, field));
                if (used && (compliance !== undefined || identityChanged)) {
                    throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.METADATA_LOCKED);
                }
                if (requestedData.manufacturerId && requestedData.manufacturerId !== current.manufacturerId) {
                    await requireSelectableSupplier(transaction, ownerId, requestedData.manufacturerId, true);
                }
                const changesLockedField = UNIT_LOCKED_FIELDS.some((field) =>
                    productFieldChanged(current, requestedData, field));
                if (changesLockedField) {
                    const [transactionCount, balanceCount] = await Promise.all([
                        transaction.inventoryTransaction.count({ where: { productId } }),
                        transaction.inventoryBalance.count({ where: { productId } }),
                    ]);
                    if (transactionCount > 0 || balanceCount > 0) {
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

                const updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
                // Validate the merged label before either product or compliance writes.
                const complianceData = compliance !== undefined || identityChanged
                    ? prepareOwnerCompliance(
                        merged, compliance, ownerId, updatedAt, current.compliance,
                        productFieldChanged(current, requestedData, 'imageUrls'),
                    ) : null;
                const result = await transaction.product.updateMany({
                    where: {
                        id: productId,
                        farmId,
                        updatedAt: versionRange(expectedUpdatedAt),
                    },
                    data: {
                        ...requestedData,
                        updatedAt,
                    },
                });
                if (result.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
                }
                if (complianceData) {
                    await transaction.productCompliance.upsert({
                        where: { productId },
                        create: {
                            ...complianceData,
                            productId,
                        },
                        update: complianceData,
                    });
                }
                const updated = await transaction.product.findUnique({
                    where: { id: productId },
                    select: productWithBalancesSelect,
                });
                return { ...updated, metadataLocked: used };
            },
            { isolationLevel: 'Serializable' },
        );
        return normalizeProduct(product);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Admin review reads are explicit V2 operations, never inferred from legacy facts.
 */
const getProductsForReview = async ({ page, limit, complianceStatus, farmId }) => {
    const where = {
        ...(farmId && { farmId }),
        compliance: { is: { complianceStatus } },
    };
    const [products, totalResults] = await Promise.all([
        prisma.product.findMany({
            where,
            select: productWithBalancesSelect,
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.product.count({ where }),
    ]);
    return {
        products: products.map((product) => normalizeProduct(product)),
        meta: { page, limit, totalResults, totalPages: Math.ceil(totalResults / limit) },
    };
};

const getProductForReview = async (productId) => {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: productWithBalancesSelect });
    if (!product) throw ApiError.notFound(messages.INVENTORY.PRODUCT_NOT_FOUND);
    return normalizeProduct(product);
};

/**
 * Share the product lock with Owner edits and execution so review applies to exact label facts.
 * Review changes also advance the product version, invalidating stale edits and reviews.
 */
const reviewProductCompliance = async (productId, input, reviewerId) => {
    const { expectedUpdatedAt, complianceStatus, reviewNote } = input;
    try {
        const product = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
            const current = await tx.product.findUnique({ where: { id: productId }, select: PRODUCT_SELECT });
            if (!current) throw ApiError.notFound(messages.INVENTORY.PRODUCT_NOT_FOUND);
            requireActiveProduct(current);
            if (!current.compliance || current.compliance.complianceStatus === complianceStatus) {
                throw ApiError.conflict(messages.INVENTORY.REVIEW_STATE_CONFLICT);
            }
            if (complianceStatus === PRODUCT_COMPLIANCE_STATUS.REVIEWED) {
                requireCompleteInventoryProduct(current);
                if (!isInventoryProductReviewable(current)) {
                    throw ApiError.badRequest(messages.INVENTORY.REVIEW_FACTS_REQUIRED);
                }
            }
            const checkedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
            const changed = await tx.product.updateMany({
                where: { id: productId, updatedAt: versionRange(expectedUpdatedAt) },
                data: { updatedAt: checkedAt },
            });
            if (changed.count !== 1) throw ApiError.conflict(messages.INVENTORY.CHANGE_CONFLICT);
            const reviewed = await tx.productCompliance.updateMany({
                where: { productId, complianceStatus: current.compliance.complianceStatus },
                data: { complianceStatus, checkedBy: reviewerId, checkedAt, reviewNote, updatedAt: checkedAt },
            });
            if (reviewed.count !== 1) throw ApiError.conflict(messages.INVENTORY.CHANGE_CONFLICT);
            return tx.product.findUnique({ where: { id: productId }, select: productWithBalancesSelect });
        }, { isolationLevel: 'Serializable' });
        return normalizeProduct(product);
    } catch (error) {
        return mapWriteError(error);
    }
};

/** Notify only current staff of open seasons that actually reference the material. */
const inventoryRecipients = async (client, farmId, productId, ownerId, seasonIds) => {
    const assignments = await client.seasonPersonnelAssignment.findMany({
        where: {
            unassignedAt: null,
            role: { in: [PERSONNEL_ROLE.TECHNICIAN, PERSONNEL_ROLE.EXPERT] },
            account: { status: ACCOUNT_STATUS.ACTIVE, managedByOwnerId: ownerId },
            ...(seasonIds && { seasonId: { in: seasonIds } }),
            season: {
                pond: { farmId, farm: { ownerId } },
                status: { in: [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE] },
                ...(!seasonIds && { OR: [
                    { schedules: { some: { productId, status: OPERATION_STATUS.PLANNED } } },
                    { protocols: { some: {
                        status: { in: [PROTOCOL_STATUS.APPROVED, PROTOCOL_STATUS.DRAFT, PROTOCOL_STATUS.PENDING_APPROVAL] },
                        items: { some: { productId } },
                    } } },
                ] }),
            },
        },
        select: { accountId: true },
    });
    return [...new Set([ownerId, ...assignments.map((assignment) => assignment.accountId)])];
};

const saveInventoryNotifications = async (client, recipients, data) => Promise.all(
    recipients.map((accountId) => client.notification.create({
        data: { ...data, accountId },
        select: { id: true, accountId: true },
    })),
);

const emitInventoryNotifications = (notifications) => {
    for (const notification of notifications) {
        emitNotification(notification.accountId, 'notification:new', { id: notification.id });
    }
};

/** Stop new use and cancel unexecuted schedules while retaining stock and history. */
const archiveProduct = (farmId, productId, ownerId) => changeStatus(farmId, productId, ownerId, PRODUCT_STATUS.INACTIVE);

/**
 * Resume an owned product; inactive rows have retained their name/unit identity.
 */
const restoreProduct = (farmId, productId, ownerId) => changeStatus(farmId, productId, ownerId, PRODUCT_STATUS.ACTIVE);

/**
 * V2 status changes never erase stock, references or historical evidence.
 */
const changeStatus = async (farmId, productId, ownerId, status) => {
    let notifications = [];
    try {
        const product = await prisma.$transaction(async (tx) => {
            await findOwnedProduct(tx, farmId, productId, ownerId, { id: true });
            // Match execution's season -> product lock order before cancelling schedules.
            const schedules = status === PRODUCT_STATUS.INACTIVE
                ? await tx.operationSchedule.findMany({
                    where: { productId, status: OPERATION_STATUS.PLANNED, execution: null },
                    select: { id: true, seasonId: true },
                }) : [];
            const seasonIds = [...new Set(schedules.map((schedule) => schedule.seasonId))].sort();
            for (const seasonId of seasonIds) {
                await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
            }
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
            const current = await findOwnedProduct(tx, farmId, productId, ownerId);
            const changedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
            const changed = await tx.product.updateMany({
                where: {
                    id: productId,
                    farmId,
                    updatedAt: versionRange(current.updatedAt),
                },
                data: {
                    status,
                    updatedAt: changedAt,
                },
            });
            if (changed.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
            }
            if (schedules.length) {
                const cancelled = await tx.operationSchedule.updateMany({
                    where: { productId, status: OPERATION_STATUS.PLANNED, execution: null },
                    data: {
                        status: OPERATION_STATUS.CANCELLED,
                        cancellationType: SCHEDULE_CANCELLATION_TYPE.MANUAL_CORRECTION,
                        cancellationReason: messages.INVENTORY.PRODUCT_ARCHIVE_REASON(current.name),
                        cancelledBy: ownerId,
                        cancelledAt: changedAt,
                        updatedAt: changedAt,
                    },
                });
                if (cancelled.count) {
                    const recipients = await inventoryRecipients(tx, farmId, productId, ownerId, seasonIds);
                    notifications = await saveInventoryNotifications(tx, recipients, {
                        title: messages.INVENTORY.SCHEDULES_CANCELLED_TITLE,
                        content: messages.INVENTORY.SCHEDULES_CANCELLED_CONTENT(current.name, cancelled.count),
                        type: NOTIFICATION_TYPE.OPERATION_CANCELLED,
                        referenceType: 'product',
                        referenceId: productId,
                    });
                }
            }
            return tx.product.findUnique({
                where: { id: productId },
                select: productWithBalancesSelect,
            });
        }, { isolationLevel: 'Serializable' });
        emitInventoryNotifications(notifications);
        return normalizeProduct(product);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Planning references can be detached after confirmation; stock and operational history cannot.
 */
const canDeleteProduct = async (client, productId) => {
    const [result] = await client.$queryRaw(Prisma.sql`SELECT NOT (
        EXISTS(SELECT 1 FROM inventory_balances WHERE product_id = ${productId}::uuid)
        OR EXISTS(SELECT 1 FROM inventory_transactions WHERE product_id = ${productId}::uuid)
        OR EXISTS(SELECT 1 FROM protocol_items i JOIN protocols p ON p.id = i.protocol_id
            WHERE i.product_id = ${productId}::uuid AND p.status <> 'draft')
        OR EXISTS(SELECT 1 FROM operation_schedules WHERE product_id = ${productId}::uuid)
        OR EXISTS(SELECT 1 FROM operation_executions WHERE actual_product_id = ${productId}::uuid)
    ) AS allowed`);
    return result.allowed;
};

const productDeletionImpact = async (client, product) => {
    if (!await canDeleteProduct(client, product.id)) return { allowed: false, token: null, message: null };
    // Keep the database timestamp precision in the confirmation fingerprint.
    const templates = await client.$queryRaw`SELECT t.id, t.title, t.version_no AS "versionNo", t.updated_at::text AS revision
        FROM production_protocol_templates t
        WHERE EXISTS(SELECT 1 FROM production_protocol_template_items i WHERE i.template_id = t.id AND i.product_id = ${product.id}::uuid)
        ORDER BY t.id`;
    const protocols = await client.$queryRaw`SELECT p.id, p.title, p.updated_at::text AS revision
        FROM protocols p WHERE EXISTS(SELECT 1 FROM protocol_items i WHERE i.protocol_id = p.id AND i.product_id = ${product.id}::uuid)
        ORDER BY p.id`;
    if (!templates.length && !protocols.length) return { allowed: true, templates, protocols, token: null, message: null };
    const token = createHash('sha256').update(JSON.stringify({
        productId: product.id, updatedAt: product.updatedAt, templates, protocols,
    })).digest('hex');
    return { allowed: true, templates, protocols, token,
        message: messages.INVENTORY.DELETE_CONFIRMATION(product.name, templates.map(row => row.title), protocols.map(row => row.title)) };
};

/** Retain names, doses and dossier snapshots so the editor can replace a deleted selection. */
const deletedMaterialDetails = (product, details, ownerId, now) => {
    const proposed = details?.proposed ?? {
        name: product.name, description: product.description, category: product.category.toLowerCase(),
        unit: product.unit.toLowerCase(), conversionUnit: product.conversionUnit?.toLowerCase() ?? null,
        conversionQuantity: product.conversionQuantity == null ? null : String(product.conversionQuantity),
        manufacturer: product.manufacturer, productCompliance: product.compliance, imageUrls: product.imageUrls,
        recommendationReason: product.recommendationReason || messages.INVENTORY.DELETED_MATERIAL_REPLACEMENT,
    };
    return JSON.parse(JSON.stringify({ proposed, ownerOverrides: details?.ownerOverrides ?? null, review: {
        ...details?.review, deletedProductId: product.id, deletedAt: now.toISOString(), deletedBy: ownerId,
    } }));
};

/**
 * Keep identity immutable after an order is issued or stock history is recorded.
 * Draft protocol references alone do not lock edits; cancelled schedules retain their history.
 */
const hasProductUsage = async (client, productId) => {
    const counts = await Promise.all([
        client.inventoryTransaction.count({ where: { productId } }),
        client.inventoryBalance.count({ where: { productId } }),
        client.operationSchedule.count({ where: { productId } }),
        client.protocolItem.count({ where: { productId, protocol: { status: { not: PROTOCOL_STATUS.DRAFT } } } }),
        client.operationExecution.count({
            where: {
                OR: [{ actualProductId: productId }, {
                    actualProductId: null,
                    schedule: { productId },
                }],
            },
        }),
    ]);
    return counts.some((count) => count > 0);
};

/**
 * Delete unused stock masters after confirming affected plans; retain their material snapshots.
 */
const deleteProduct = async (farmId, productId, ownerId, input = {}) => {
    try {
        const notifications = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
            const product = await findOwnedProduct(tx, farmId, productId, ownerId);
            const impact = await productDeletionImpact(tx, product);
            if (!impact.allowed) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.HAS_REFERENCES);
            }
            if (impact.token && input.confirmationToken !== impact.token) {
                throw ApiError.conflict(input.confirmationToken
                    ? messages.INVENTORY.CHANGE_CONFLICT : impact.message);
            }
            const now = new Date();
            const templateItems = await tx.productionProtocolTemplateItem.findMany({
                where: { productId }, select: { id: true, recommendedProductDetails: true },
            });
            for (const item of templateItems) await tx.productionProtocolTemplateItem.update({
                where: { id: item.id }, data: { productId: null,
                    recommendedProductDetails: deletedMaterialDetails(product, item.recommendedProductDetails, ownerId, now) },
                select: { id: true },
            });
            for (const template of impact.templates) {
                // The standalone V2 schema stores this status as VARCHAR; the application schema uses an enum.
                // An SQL literal is accepted by both, unlike Prisma's enum-typed bind parameter.
                const updated = await tx.$executeRaw`UPDATE production_protocol_templates
                    SET status = 'inactive', version_no = version_no + 1, updated_at = ${now}
                    WHERE id = ${template.id}::uuid AND version_no = ${template.versionNo}`;
                if (updated !== 1) throw ApiError.conflict(messages.INVENTORY.CHANGE_CONFLICT);
            }
            const protocolItems = await tx.protocolItem.findMany({
                where: { productId }, select: { id: true, recommendedProductDetails: true },
            });
            for (const item of protocolItems) {
                const updated = await tx.protocolItem.updateMany({
                    where: { id: item.id, productId }, data: { productId: null, materialSnapshot: Prisma.DbNull,
                        recommendedProductDetails: deletedMaterialDetails(product, item.recommendedProductDetails, ownerId, now) },
                });
                if (updated.count !== 1) throw ApiError.conflict(messages.INVENTORY.CHANGE_CONFLICT);
            }
            if (impact.protocols.length) {
                const updated = await tx.protocol.updateMany({
                    where: { id: { in: impact.protocols.map(row => row.id) }, status: PROTOCOL_STATUS.DRAFT }, data: { updatedAt: now },
                });
                if (updated.count !== impact.protocols.length) throw ApiError.conflict(messages.INVENTORY.CHANGE_CONFLICT);
            }
            const changed = await tx.product.deleteMany({
                where: {
                    id: productId,
                    farmId,
                },
            });
            if (changed.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
            }
            return saveInventoryNotifications(tx, [ownerId], {
                type: NOTIFICATION_TYPE.SYSTEM, title: messages.INVENTORY.DELETED_NOTIFICATION_TITLE,
                content: messages.INVENTORY.DELETED_NOTIFICATION_CONTENT(product.name, impact.templates.map(row => row.title), impact.protocols.map(row => row.title)),
                referenceType: 'inventory_product', referenceId: productId,
            });
        }, { isolationLevel: 'Serializable' });
        emitInventoryNotifications(notifications);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Fill an unknown manufacturer-lot expiry consistently without rewriting used-lot evidence.
 */
const updateLotExpiry = async (farmId, productId, balanceId, input, ownerId) => {
    try {
        return await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
            await findOwnedProduct(tx, farmId, productId, ownerId);
            const current = await tx.inventoryBalance.findFirst({
                where: {
                    id: balanceId,
                    productId,
                },
                select: BALANCE_SELECT,
            });
            if (!current) {
                throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.BALANCE_NOT_FOUND);
            }
            if (current.updatedAt < input.expectedUpdatedAt || current.updatedAt >= new Date(input.expectedUpdatedAt.getTime() + 1)) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.CHANGE_CONFLICT);
            }
            const layers = (await tx.inventoryBalance.findMany({
                where: { productId },
                select: BALANCE_SELECT,
            }))
                .filter((layer) => normalizeNameKey(layer.lotNumber) === normalizeNameKey(current.lotNumber));
            const expiryDate = new Date(input.expiryDate);
            if (layers.some((layer) => layer.expiryDate && !dateEqual(layer.expiryDate, expiryDate))) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.LOT_EXPIRY_CONFLICT);
            }
            const used = await tx.inventoryTransaction.count({
                where: {
                    inventoryBalanceId: { in: layers.map((layer) => layer.id) },
                    referenceType: 'operation_execution',
                },
            });
            if (used) {
                throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.LOT_EXPIRY_LOCKED);
            }
            await tx.inventoryBalance.updateMany({
                where: {
                    id: { in: layers.map((layer) => layer.id) },
                    expiryDate: null,
                },
                data: { expiryDate },
            });
            return normalizeBalance(await tx.inventoryBalance.findUnique({
                where: { id: balanceId },
                select: BALANCE_SELECT,
            }));
        }, { isolationLevel: 'Serializable' });
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
            && nullableTextEqual(existing.inventoryBalance.expiryDate?.toISOString().slice(0, 10), data.expiryDate ? new Date(data.expiryDate).toISOString().slice(0, 10) : null)
            && decimalEqual(existing.inventoryBalance.unitPrice, data.unitPrice)
            && (data.supplierId
                ? existing.inventoryBalance.supplierId === data.supplierId
                : !existing.inventoryBalance.supplierId
                    && normalizeNameKey(existing.inventoryBalance.supplierNameSnapshot)
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
    let notifications = [];
    if (!OWNER_INVENTORY_TRANSACTION_TYPES.includes(transactionData.transactionType)) {
        throw new ApiError(httpStatus.FORBIDDEN, messages.AUTH.FORBIDDEN);
    }
    if (
        [INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN, INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT,
            INVENTORY_TRANSACTION_TYPE.STOCK_OUT]
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
                await transaction.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
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
                if ([INVENTORY_TRANSACTION_TYPE.STOCK_IN, INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN].includes(transactionData.transactionType)) {
                    requireActiveProduct(product);
                }
                // Manual issues may dispose of blocked/expired stock; pond use has its own eligibility gate.
                const previousStock = await getProductStock(transaction, productId);
                const movementQuantity = decimal(transactionData.quantity);
                let balance;
                let totalAmount;

                if (transactionData.transactionType === INVENTORY_TRANSACTION_TYPE.STOCK_IN) {
                    if (!transactionData.supplierId) {
                        throw new ApiError(httpStatus.BAD_REQUEST, messages.INVENTORY.SUPPLIER_NAME_REQUIRED);
                    }
                    const supplier = await requireSelectableSupplier(transaction, ownerId, transactionData.supplierId);
                    const supplierName = supplier.name;
                    totalAmount = calculateTransactionAmount(
                        movementQuantity,
                        transactionData.unitPrice,
                    );
                    const existingLayers = await transaction.inventoryBalance.findMany({
                        where: { productId },
                        select: {
                            lotNumber: true,
                            expiryDate: true,
                        },
                    });
                    const expiryDate = transactionData.expiryDate ? new Date(transactionData.expiryDate) : null;
                    if (existingLayers.some((layer) => normalizeNameKey(layer.lotNumber) === normalizeNameKey(transactionData.lotNumber)
                        && !nullableTextEqual(layer.expiryDate?.toISOString().slice(0, 10), expiryDate?.toISOString().slice(0, 10)))) {
                        throw new ApiError(httpStatus.CONFLICT, messages.INVENTORY.LOT_EXPIRY_CONFLICT);
                    }
                    balance = await transaction.inventoryBalance.create({
                        data: {
                            productId,
                            lotNumber: transactionData.lotNumber,
                            receivedAt: transactionData.receivedAt,
                            quantity: movementQuantity,
                            unitPrice: decimal(transactionData.unitPrice),
                            supplierNameSnapshot: supplierName,
                            expiryDate,
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
                    const recipients = await inventoryRecipients(transaction, farmId, productId, ownerId);
                    notifications = await saveInventoryNotifications(transaction, recipients, {
                        title: messages.INVENTORY.LOW_STOCK_TITLE,
                        content:
                            `${product.name} còn ${currentAlertStock.toString()} ${alertUnit(product)}, `
                            + `thấp hơn ngưỡng ${threshold.toString()} ${alertUnit(product)}.`,
                        type: NOTIFICATION_TYPE.INVENTORY_LOW,
                        referenceType: 'PRODUCT',
                        referenceId: productId,
                    });
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

        emitInventoryNotifications(notifications);
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
        select: {
            id: true,
            name: true,
            category: true,
            unit: true,
        },
    },
    inventoryBalance: { select: BALANCE_SELECT },
    season: {
        select: {
            id: true,
            name: true,
            pond: { select: { name: true } },
        },
    },
    performer: {
        select: {
            id: true,
            fullName: true,
            email: true,
        },
    },
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
        search,
    } = query;
    const where = {
        product: { farmId },
        ...(productId && { productId }),
        ...(transactionType && { transactionType }),
        ...(seasonId && { seasonId }),
        ...(search && {
            OR: [
                {
                    product: {
                        name: {
                            contains: search,
                            mode: 'insensitive',
                        },
                    },
                },
                {
                    inventoryBalance: {
                        lotNumber: {
                            contains: search,
                            mode: 'insensitive',
                        },
                    },
                },
                {
                    inventoryBalance: {
                        supplierNameSnapshot: {
                            contains: search,
                            mode: 'insensitive',
                        },
                    },
                },
                {
                    reason: {
                        contains: search,
                        mode: 'insensitive',
                    },
                },
            ],
        }),
        ...(referenceType && {
            referenceType,
            referenceId,
        }),
        ...((createdFrom || createdTo) && {
            createdAt: {
                ...(createdFrom && { gte: createdFrom }),
                ...(createdTo && { lte: createdTo }),
            },
        }),
    };

    if (cursor) {
        const cursorTransaction = await prisma.inventoryTransaction.findFirst({
            where: {
                ...where,
                id: cursor,
            },
            select: { id: true },
        });
        if (!cursorTransaction) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.INVENTORY.INVALID_CURSOR);
        }
    }

    const [rows, totalResults, inbound, outbound, filterOptions] = await Promise.all([
        prisma.inventoryTransaction.findMany({
            where,
            select: HISTORY_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && {
                cursor: { id: cursor },
                skip: 1,
            }),
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
        getHistoryOptions(farmId),
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
            filterOptions,
            summary: {
                totalInboundValue: Number(inbound._sum.totalAmount || 0),
                totalOutboundValue: Number(outbound._sum.totalAmount || 0),
            },
        },
    };
};

module.exports = {
    getProductsForReview: legacyRead.guardWrite(getProductsForReview),
    getProductForReview: legacyRead.guardWrite(getProductForReview),
    reviewProductCompliance: legacyRead.guardWrite(reviewProductCompliance),
    getProducts: async (...args) => (await legacyRead.isV2() ? getProducts : legacyRead.getProducts)(...args),
    getProduct: async (...args) => (await legacyRead.isV2() ? getProduct : legacyRead.getProduct)(...args),
    createProduct: legacyRead.guardWrite(createProduct),
    updateProduct: legacyRead.guardWrite(updateProduct),
    archiveProduct: legacyRead.guardWrite(archiveProduct),
    restoreProduct: legacyRead.guardWrite(restoreProduct),
    deleteProduct: legacyRead.guardWrite(deleteProduct),
    updateLotExpiry: legacyRead.guardWrite(updateLotExpiry),
    recordStockTransaction: legacyRead.guardWrite(recordStockTransaction),
    getInventoryHistory: async (...args) => (await legacyRead.isV2() ? getInventoryHistory : legacyRead.getInventoryHistory)(...args),
};
