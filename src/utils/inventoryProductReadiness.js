const ApiError = require('./ApiError');
const { messages, PRODUCT_REGULATORY_TYPE } = require('../constants');
const { requireUsableIngredients } = require('./inventorySubstances');

const classifiedTypes = Object.values(PRODUCT_REGULATORY_TYPE);

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
    if (registration && expectedPrefix && (!new RegExp(`^${expectedPrefix}[0-9]{6}$`, 'u').test(registration)
        || registration.endsWith('-000000'))) {
        return messages.MATERIAL_COMPLIANCE.REGISTRATION_FORMAT(expectedPrefix);
    }
    if (registration && compliance.regulatoryType === PRODUCT_REGULATORY_TYPE.MEDICINE
        && /^(?:01|02|03)-/u.test(registration)) {
        return messages.MATERIAL_COMPLIANCE.MEDICINE_REGISTRATION_FORMAT;
    }
    return null;
};

/** Check required catalog and declaration facts without inferring legal approval. */
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

/** Validate declared label facts at catalog creation, amendment and restoration. */
const requireCompleteInventoryProduct = (product) => {
    requireUsableIngredients([product?.name, product?.description, product?.compliance?.ingredientsText].filter(Boolean).join('\n'));
    if (!hasLabelImages(product)) throw ApiError.badRequest(messages.INVENTORY.LABEL_IMAGE_REQUIRED);
    if (!isCompleteInventoryProduct(product)) {
        throw ApiError.badRequest(messages.INVENTORY.INCOMPLETE_PRODUCT);
    }
    const issue = complianceConsistencyIssue(product.compliance);
    if (issue) throw ApiError.badRequest(issue);
};

module.exports = {
    requireCompleteInventoryProduct, complianceConsistencyIssue, hasLabelImages,
};
