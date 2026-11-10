const messages = require('../constants/messages.js');
const ApiError = require('./ApiError');
const {
    LEGAL_BASIS,
    LEGAL_SOURCE,
} = require('../constants/prohibitedAquacultureIngredients');
const { checkIngredients } = require('./inventorySubstances');
const { isInventoryProductReviewable, complianceConsistencyIssue, hasLabelImages } = require('./inventoryProductReadiness');

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
        ['reviewNote', messages.MATERIAL_COMPLIANCE.REVIEW_NOTE_REQUIRED],
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
// Both catalogue records and proposal snapshots require label photos and complete facts.
const isReviewed = (product, details) => Boolean(
    hasLabelImages(product) && details?.complianceStatus === 'reviewed' && details.checkedBy && details.checkedAt &&
    (product.id
        ? isInventoryProductReviewable({ ...product, compliance: details })
        : complianceMissingFields(details).length === 0),
);
const getMaterialSafety = (product) => {
    if (product.deletedProductId) return { status: 'UNVERIFIED', reason: messages.INVENTORY.DELETED_MATERIAL_REPLACEMENT };
    const check = checkProductIngredients(product);
    if (check.status !== 'not_detected') return { status: 'BANNED', reason: check.message };
    const details = complianceOf(product);
    if (details?.complianceStatus === 'blocked')
        return {
            status: 'BANNED',
            reason: messages.MATERIAL_COMPLIANCE.PROHIBITED_WARNING,
        };
    if (details?.containsAntibiotic === true)
        return {
            status: 'TREATMENT_ONLY',
            reason: messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_TREATMENT_ONLY,
        };
    if (!isReviewed(product, details)) {
        return {
            status: 'UNVERIFIED',
            reason: messages.MATERIAL_COMPLIANCE.PROFILE_INCOMPLETE,
        };
    }
    return { status: 'VERIFIED', reason: null };
};

/** Saved plans must contain complete material dossiers; photos never bypass prohibited-ingredient checks. */
const assertMaterialSafety = (
    product,
    environment,
    _instructions,
    { requireReviewed = true, production = true } = {},
) => {
    const safety = getMaterialSafety(product);
    if (product.deletedProductId) throw ApiError.badRequest(safety.reason);
    const details = complianceOf(product);
    const reviewed = isReviewed(product, details);
    if (safety.status === 'BANNED') throw ApiError.badRequest(safety.reason);
    if (
        (production && safety.status === 'TREATMENT_ONLY') ||
        (requireReviewed && !reviewed)
    )
        throw ApiError.badRequest(
            `${product.name}: ${safety.reason || messages.MATERIAL_COMPLIANCE.PROFILE_INCOMPLETE}`,
        );
    if (requireReviewed && product.id && !product.manufacturerId)
        throw ApiError.badRequest(
            messages.MATERIAL_COMPLIANCE.MANUFACTURER_UNVERIFIED(product.name),
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
const reviewProposal = (product, accountId, now = new Date()) => {
    assertNoProhibitedIngredients(product);
    if (!hasLabelImages(product)) throw ApiError.badRequest(messages.INVENTORY.LABEL_IMAGE_REQUIRED);
    if (!product.manufacturerId && !product.manufacturer?.name?.trim()) {
        throw ApiError.badRequest(messages.MATERIAL_COMPLIANCE.MANUFACTURER_REVIEW_REQUIRED);
    }
    const details = product.productCompliance ?? {};
    const missing = complianceMissingFields({
        ...details, reviewNote: messages.MATERIAL_COMPLIANCE.PROPOSAL_COMPLETENESS_NOTE,
    });
    if (missing.length) {
        throw ApiError.badRequest(messages.MATERIAL_COMPLIANCE.MISSING_PROPOSAL_FIELDS(missing.join(', ')));
    }
    // These stamps identify the server-checked submission, not an independent evidence review.
    return {
        complianceStatus: 'reviewed',
        checkedBy: accountId,
        checkedAt: now.toISOString(),
    };
};

/**
 * The author/time stamp records this submission, not independent evidence verification.
 * Proposals remain planning snapshots and never authorize operational use of a catalog product.
 */
const assessTemplateProposal = (product, accountId, now = new Date()) => {
    assertNoProhibitedIngredients(product);
    const candidate = {
        ...Object.fromEntries(
            Object.entries(product.productCompliance ?? {}).filter(
                ([field]) =>
                    !['complianceStatus', 'reviewNote', 'checkedBy', 'checkedAt'].includes(field),
            ),
        ),
        reviewNote: messages.MATERIAL_COMPLIANCE.PROPOSAL_COMPLETENESS_NOTE,
    };
    const productCompliance = {
        ...candidate,
        complianceStatus: 'reviewed',
    };
    return {
        productCompliance,
        review: reviewProposal({ ...product, productCompliance }, accountId, now),
    };
};
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
    reviewProposal,
    assessTemplateProposal,
    productFromRecommendation,
};
