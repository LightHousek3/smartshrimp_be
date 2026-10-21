const Joi = require('joi');
const {
    PRODUCT_CATEGORY,
    PRODUCT_UNIT,
    CONVERSION_UNIT,
    OWNER_INVENTORY_TRANSACTION_TYPES,
    INVENTORY_TRANSACTION_TYPE,
    PRODUCT_STOCK_STATUS,
    PRODUCT_ARCHIVE_STATUS,
} = require('../constants');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');
/**
 * Collapse whitespace before checking persisted name and lot-number lengths.
 */
const normalizedText = (max) => Joi.string().custom(normalizeWhitespace).min(1).max(max);
/**
 * Match PostgreSQL quantity precision and reject implicit rounding at the request boundary.
 */
const quantity = Joi.number().positive().max(99999999999.999).precision(3).strict();
const nonnegativeQuantity = Joi.number().min(0).max(99999999999.999).precision(3).strict();
const unitPrice = Joi.number().min(0).max(999999999999.99).precision(2).strict();
const conversionQuantity = Joi.number().positive().max(9999999999.9999).precision(4).strict();

const farmParams = Joi.object({ farmId: uuid.required() });
const productParams = Joi.object({
    farmId: uuid.required(),
    productId: uuid.required(),
});

const productFields = {
    name: normalizedText(255),
    category: Joi.string().valid(...Object.values(PRODUCT_CATEGORY)),
    unit: Joi.string().valid(...Object.values(PRODUCT_UNIT)),
    conversionQuantity: conversionQuantity.allow(null),
    conversionUnit: Joi.string().valid(...Object.values(CONVERSION_UNIT)).allow(null),
    minAlertQuantity: nonnegativeQuantity,
    description: Joi.string().trim().max(5000).allow('', null),
    imageUrls: Joi.array().items(Joi.string().trim().uri({ scheme: ['https'] }).max(2048)).unique().max(3),
    imageUrl: Joi.string().trim().uri({ scheme: ['https'] }).max(2048).allow(null),
};

/**
 * Require paired conversion fields for packaged products during creation.
 * Partial updates are checked against the current product in the service.
 */
const validateConversion = (value, helpers) => {
    const packaged = [PRODUCT_UNIT.PACK, PRODUCT_UNIT.BOTTLE].includes(value.unit);
    const hasQuantity = value.conversionQuantity != null;
    const hasUnit = value.conversionUnit != null;

    if (packaged && (!hasQuantity || !hasUnit)) {
        return helpers.message({
            custom: 'conversionQuantity and conversionUnit are required for PACK and BOTTLE',
        });
    }
    if (!packaged && (hasQuantity || hasUnit)) {
        return helpers.message({
            custom: 'conversionQuantity and conversionUnit are only allowed for PACK and BOTTLE',
        });
    }
    return value;
};

/**
 * Validate catalog filters and pagination; ownership remains a service concern.
 */
const getProducts = {
    params: farmParams,
    query: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        search: Joi.string().trim().max(255).allow('').default(''),
        category: Joi.string().valid(...Object.values(PRODUCT_CATEGORY)),
        stockStatus: Joi.string()
            .valid(...Object.values(PRODUCT_STOCK_STATUS))
            .default(PRODUCT_STOCK_STATUS.ALL),
        archiveStatus: Joi.string()
            .valid(...Object.values(PRODUCT_ARCHIVE_STATUS))
            .default(PRODUCT_ARCHIVE_STATUS.ACTIVE),
    }),
};

/**
 * Require catalog identity and enforce conversion and image limits before creation.
 */
const createProduct = {
    params: farmParams,
    body: Joi.object({
        ...productFields,
        name: normalizedText(255).required(),
        category: Joi.string().valid(...Object.values(PRODUCT_CATEGORY)).required(),
        unit: Joi.string().valid(...Object.values(PRODUCT_UNIT)).required(),
        minAlertQuantity: nonnegativeQuantity.default(0),
    }).custom(validateConversion),
};

/**
 * Reject empty patches and require a version token for optimistic concurrency.
 */
const updateProduct = {
    params: productParams,
    body: Joi.object({
        ...productFields,
        expectedUpdatedAt: Joi.date().iso().required(),
    }).or(...Object.keys(productFields)),
};

/**
 * A receipt creates a lot and identifies its supplier by either directory ID or name.
 */
const stockInBody = Joi.object({
    transactionType: Joi.string().valid(INVENTORY_TRANSACTION_TYPE.STOCK_IN).required(),
    lotNumber: normalizedText(100).required(),
    receivedAt: Joi.date().iso().max('now').required(),
    quantity: quantity.required(),
    unitPrice: unitPrice.required(),
    supplierName: normalizedText(255),
    supplierId: uuid,
    reason: Joi.string().trim().max(2000).allow('', null),
}).xor('supplierId', 'supplierName');

/**
 * Require a reason for every adjustment so manual corrections remain traceable.
 */
const adjustmentBody = Joi.object({
    transactionType: Joi.string()
        .valid(
            INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN,
            INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT,
        )
        .required(),
    inventoryBalanceId: uuid.required(),
    quantity: quantity.required(),
    reason: Joi.string().trim().min(1).max(2000).required(),
});

const stockOutBody = Joi.object({
    transactionType: Joi.string().valid(INVENTORY_TRANSACTION_TYPE.STOCK_OUT).required(),
    inventoryBalanceId: uuid.required(),
    quantity: quantity.required(),
    reason: Joi.string().trim().max(2000).allow('', null),
});

/**
 * Accept only Owner movement shapes; the service checks lot ownership and available stock.
 */
const recordStockTransaction = {
    params: productParams,
    body: Joi.alternatives()
        .match('one')
        .try(stockInBody, adjustmentBody, stockOutBody)
        .custom((value, helpers) => {
            if (!OWNER_INVENTORY_TRANSACTION_TYPES.includes(value.transactionType)) {
                return helpers.error('any.only');
            }
            return value;
        }),
};

/**
 * Keep reference filters paired and reject reversed date ranges before querying the ledger.
 */
const getInventoryHistory = {
    params: farmParams,
    query: Joi.object({
        cursor: uuid,
        limit: Joi.number().integer().min(1).max(100).default(20),
        productId: uuid,
        transactionType: Joi.string().valid(...Object.values(INVENTORY_TRANSACTION_TYPE)),
        seasonId: uuid,
        referenceType: Joi.string().trim().min(1).max(50),
        referenceId: uuid,
        createdFrom: Joi.date().iso(),
        createdTo: Joi.date().iso(),
    })
        .and('referenceType', 'referenceId')
        .custom((value, helpers) => {
            if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
                return helpers.message({ custom: 'createdFrom must not be after createdTo' });
            }
            return value;
        }),
};

module.exports = {
    getProducts,
    getProduct: { params: productParams },
    createProduct,
    updateProduct,
    archiveProduct: { params: productParams },
    restoreProduct: { params: productParams },
    recordStockTransaction,
    getInventoryHistory,
};
