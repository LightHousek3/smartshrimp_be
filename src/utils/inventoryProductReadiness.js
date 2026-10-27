const ApiError = require('./ApiError');
const { messages, PRODUCT_REGULATORY_TYPE } = require('../constants');

const classifiedTypes = Object.values(PRODUCT_REGULATORY_TYPE)
    .filter((type) => type !== PRODUCT_REGULATORY_TYPE.UNCLASSIFIED);

const isCompleteInventoryProduct = (product) => {
    const compliance = product?.compliance;
    const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
    return Boolean(product && textPresent(product.manufacturerId)
        && compliance && classifiedTypes.includes(compliance.regulatoryType)
        && textPresent(compliance.registrationNumber)
        && textPresent(compliance.ingredientsText)
        && textPresent(compliance.usageInstructions)
        && typeof compliance.containsAntibiotic === 'boolean'
        && compliance.withdrawalDays != null
        && Number.isFinite(Number(compliance.withdrawalDays))
        && Number(compliance.withdrawalDays) >= 0);
};

/**
 * Completeness confirms Owner-supplied facts, not independent regulatory verification.
 * Explicit false and zero are valid facts; photos and evidence are optional.
 */
const isInventoryProductReviewable = (product) => isCompleteInventoryProduct(product)
    && (!product.compliance.containsAntibiotic
        || product.compliance.regulatoryType === PRODUCT_REGULATORY_TYPE.MEDICINE);

/**
 * Operational callers check essential facts even when a reviewed record already exists.
 */
const requireCompleteInventoryProduct = (product) => {
    if (!isCompleteInventoryProduct(product)) {
        throw ApiError.badRequest(messages.INVENTORY.INCOMPLETE_PRODUCT);
    }
};

module.exports = { requireCompleteInventoryProduct, isInventoryProductReviewable };
