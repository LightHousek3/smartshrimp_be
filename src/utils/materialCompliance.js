const messages = require('../constants/messages.js');
const ApiError = require('./ApiError');
const {
    LEGAL_BASIS,
    LEGAL_SOURCE,
} = require('../constants/prohibitedAquacultureIngredients');
const { checkIngredients } = require('./inventorySubstances');
const { complianceConsistencyIssue, hasLabelImages } = require('./inventoryProductReadiness');

const complianceOf = (product) => product.productCompliance ?? product.compliance;
const checkProductIngredients = (product) => checkIngredients(
    [product.name, product.description, complianceOf(product)?.ingredientsText]
        .filter(Boolean).join('\n'),
);

/**
 * Scan product identity and ingredients, excluding URLs, instructions and recommendation reasons.
 * A negative claim containing a prohibited name still requires review and cannot bypass blocking.
 * No keyword match is not evidence that a material is legally eligible for use.
 */
const findProhibitedIngredients = (product) => {
    return checkProductIngredients(product).matches
        .map(({ sourceRow, name }) => ({ number: Number(sourceRow), name }));
};
/** Block both detected prohibited ingredients and ambiguous declarations requiring review. */
const assertNoProhibitedIngredients = (product) => {
    const check = checkProductIngredients(product);
    if (check.status !== 'not_detected') throw ApiError.badRequest(check.message);
};

/** Check profile completeness only; these fields do not prove that an Expert verified the evidence. */
const complianceMissingFields = (details) => {
    const missing = [];
    if (!['feed', 'environment', 'dual_purpose', 'medicine'].includes(details?.regulatoryType))
        missing.push(messages.MATERIAL_COMPLIANCE.REGULATORY_TYPE_REQUIRED);
    for (const [field, label] of [
        ['registrationNumber', messages.MATERIAL_COMPLIANCE.REGISTRATION_REQUIRED],
        ['ingredientsText', messages.MATERIAL_COMPLIANCE.INGREDIENTS_REQUIRED],
        ['usageInstructions', messages.MATERIAL_COMPLIANCE.LABEL_USAGE_REQUIRED],
    ]) {
        if (typeof details?.[field] !== 'string' || !details[field].trim()) missing.push(label);
    }
    if (typeof details?.containsAntibiotic !== 'boolean')
        missing.push(messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_CLASSIFICATION_REQUIRED);
    const consistencyIssue = complianceConsistencyIssue(details);
    if (consistencyIssue) missing.push(consistencyIssue);
    if (details?.regulatoryType === 'medicine' &&
        (details.withdrawalDays == null || !Number.isFinite(Number(details.withdrawalDays)) || Number(details.withdrawalDays) < 0))
        missing.push(messages.MATERIAL_COMPLIANCE.WITHDRAWAL_REQUIRED);
    return missing;
};
// Input validation records the declaration; operational reads do not repeat label validation.
const isDeclared = details => Boolean(
    ['feed', 'environment', 'dual_purpose', 'medicine'].includes(details?.regulatoryType)
    && details.checkedBy && details.checkedAt,
);
/** Classify the stored declaration as usable, treatment-only or unavailable. */
const getMaterialSafety = (product) => {
    if (product.deletedProductId) return { status: 'UNVERIFIED', reason: messages.INVENTORY.DELETED_MATERIAL_REPLACEMENT };
    const details = complianceOf(product);
    if (product.id && product.status && product.status !== 'ACTIVE') {
        return { status: 'UNVERIFIED', reason: messages.PRODUCTION_PROTOCOL.PRODUCT };
    }
    if (details?.containsAntibiotic === true)
        return {
            status: 'TREATMENT_ONLY',
            reason: messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_TREATMENT_ONLY,
        };
    if (!isDeclared(details)) {
        return {
            status: 'UNVERIFIED',
            reason: messages.MATERIAL_COMPLIANCE.PROFILE_INCOMPLETE,
        };
    }
    return { status: 'VERIFIED', reason: null };
};

/** Apply the persisted dossier decision and the prescription's permitted route. */
const assertMaterialSafety = (
    product,
    environment,
    _instructions,
    { production = true } = {},
) => {
    const safety = getMaterialSafety(product);
    if (product.deletedProductId) throw ApiError.badRequest(safety.reason);
    const details = complianceOf(product);
    if (
        (production && safety.status === 'TREATMENT_ONLY') ||
        safety.status === 'UNVERIFIED' || !isDeclared(details)
    )
        throw ApiError.badRequest(
            `${product.name}: ${safety.reason || messages.MATERIAL_COMPLIANCE.PROFILE_INCOMPLETE}`,
        );
    if (
        details &&
        ((environment && details.regulatoryType === 'feed') ||
            (!environment && details.regulatoryType === 'environment'))
    ) {
        throw ApiError.badRequest(
            messages.MATERIAL_COMPLIANCE.INCOMPATIBLE_LEGAL_USE(product.name),
        );
    }
};
/** Validate the proposal before stamping its declaring account and submission time. */
const confirmProposal = (product, accountId, now = new Date()) => {
    assertNoProhibitedIngredients(product);
    if (!hasLabelImages(product)) throw ApiError.badRequest(messages.INVENTORY.LABEL_IMAGE_REQUIRED);
    if (!product.manufacturerId && !product.manufacturer?.name?.trim()) {
        throw ApiError.badRequest(messages.MATERIAL_COMPLIANCE.MANUFACTURER_REQUIRED);
    }
    const details = product.productCompliance ?? {};
    const missing = complianceMissingFields(details);
    if (!product.recommendationReason?.trim()) missing.push(messages.MATERIAL_COMPLIANCE.PROPOSAL_REASON_REQUIRED);
    if (missing.length) {
        throw ApiError.badRequest(messages.MATERIAL_COMPLIANCE.MISSING_PROPOSAL_FIELDS(missing.join(', ')));
    }
    // These stamps identify the server-checked submission, not an independent evidence review.
    return {
        checkedBy: accountId,
        checkedAt: now.toISOString(),
    };
};

/**
 * The author/time stamp records this submission, not independent evidence verification.
 * Proposals remain planning snapshots and never authorize operational use of a catalog product.
 */
const assessTemplateProposal = (product, accountId, now = new Date()) => {
    const fields = ['regulatoryType', 'registrationNumber', 'ingredientsText', 'containsAntibiotic',
        'usageInstructions', 'withdrawalDays', 'evidenceUrls'];
    const productCompliance = Object.fromEntries(fields.filter(field => Object.hasOwn(product.productCompliance ?? {}, field))
        .map(field => [field, product.productCompliance[field]]));
    return {
        productCompliance,
        review: confirmProposal({ ...product, productCompliance }, accountId, now),
    };
};
/** Reconstruct proposal display fields without assigning a catalog product identity. */
const productFromRecommendation = (details) =>
    details?.proposed
        ? {
              ...details.proposed,
              deletedProductId: details.review?.deletedProductId ?? null,
              category: details.proposed.category?.toUpperCase(),
              unit: details.proposed.unit?.toUpperCase(),
              conversionUnit: details.proposed.conversionUnit?.toUpperCase() ?? null,
              productCompliance: {
                  ...details.proposed.productCompliance,
                  ...details.review,
              },
          }
        : null;
module.exports = {
    LEGAL_BASIS,
    LEGAL_SOURCE,
    findProhibitedIngredients,
    assertNoProhibitedIngredients,
    complianceMissingFields,
    getMaterialSafety,
    assertMaterialSafety,
    assessTemplateProposal,
    productFromRecommendation,
};
