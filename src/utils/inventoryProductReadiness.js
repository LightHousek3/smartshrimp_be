const ApiError = require('./ApiError');
const { messages, PRODUCT_REGULATORY_TYPE } = require('../constants');
const { checkIngredients, requireUsableIngredients } = require('./inventorySubstances');

const classifiedTypes = Object.values(PRODUCT_REGULATORY_TYPE)
    .filter((type) => type !== PRODUCT_REGULATORY_TYPE.UNCLASSIFIED);

const receiptPrefixes = {
    [PRODUCT_REGULATORY_TYPE.FEED]: '01-',
    [PRODUCT_REGULATORY_TYPE.ENVIRONMENT]: '02-',
    [PRODUCT_REGULATORY_TYPE.DUAL_PURPOSE]: '03-',
};

const hasLabelImages = (product) => Array.isArray(product?.imageUrls)
    && product.imageUrls.length >= 1 && product.imageUrls.length <= 3
    && product.imageUrls.every((value) => {
        if (typeof value !== 'string') return false;
        try { return new URL(value).protocol === 'https:'; }
        catch { return false; }
    });

/** Check dossier consistency without claiming to verify a registration externally. */
const complianceConsistencyIssue = (compliance) => {
    if (!compliance) return null;
    if (compliance.containsAntibiotic === true
        && compliance.regulatoryType !== PRODUCT_REGULATORY_TYPE.MEDICINE) {
        return messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_REQUIRES_MEDICINE;
    }
    const registration = typeof compliance.registrationNumber === 'string'
        ? compliance.registrationNumber.trim() : '';
    const expectedPrefix = receiptPrefixes[compliance.regulatoryType];
    if (registration && ((expectedPrefix
        && (!registration.startsWith(expectedPrefix) || registration.length === expectedPrefix.length))
        || (compliance.regulatoryType === PRODUCT_REGULATORY_TYPE.MEDICINE
            && /^(?:01|02|03)-/u.test(registration)))) {
        return messages.MATERIAL_COMPLIANCE.REGISTRATION_TYPE_MISMATCH;
    }
    return null;
};

const isCompleteInventoryProduct = (product) => {
    const compliance = product?.compliance;
    const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
    return Boolean(product && textPresent(product.manufacturerId) && hasLabelImages(product)
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
 * Explicit false and zero are valid facts; at least one label image is required.
 */
const isInventoryProductReviewable = (product) => isCompleteInventoryProduct(product)
    && checkIngredients(product.compliance.ingredientsText).status === 'not_detected'
    && !complianceConsistencyIssue(product.compliance);

/**
 * Operational callers check essential facts even when a reviewed record already exists.
 */
const requireCompleteInventoryProduct = (product) => {
    requireUsableIngredients(product?.compliance?.ingredientsText);
    if (!hasLabelImages(product)) throw ApiError.badRequest(messages.INVENTORY.LABEL_IMAGE_REQUIRED);
    if (!isCompleteInventoryProduct(product)) {
        throw ApiError.badRequest(messages.INVENTORY.INCOMPLETE_PRODUCT);
    }
    const issue = complianceConsistencyIssue(product.compliance);
    if (issue) throw ApiError.badRequest(issue);
};

module.exports = {
    requireCompleteInventoryProduct, isInventoryProductReviewable, complianceConsistencyIssue, hasLabelImages,
};
