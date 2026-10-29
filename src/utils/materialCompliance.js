const messages = require('../constants/messages.js');
const ApiError = require('./ApiError');
const {
    LEGAL_BASIS,
    LEGAL_SOURCE,
    PROHIBITED_INGREDIENTS,
} = require('../constants/prohibitedAquacultureIngredients');

const normalize = (value) =>
    String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
const patterns = PROHIBITED_INGREDIENTS.map((entry) => ({
    ...entry,
    patterns: entry.aliases.map(
        (alias) => new RegExp(`(?:^| )${normalize(alias).replace(/ /g, ' *')}(?= |$)`),
    ),
}));

/**
 * Scan product identity and ingredients, excluding URLs, instructions and recommendation reasons.
 * A negative claim containing a prohibited name still requires review and cannot bypass blocking.
 * No keyword match is not evidence that a material is legally eligible for use.
 */
const findProhibitedIngredients = (product) => {
    const compliance = product.productCompliance ?? {};
    const text = normalize(
        [product.name, product.description, compliance.ingredientsText].filter(Boolean).join(' '),
    );
    return patterns
        .filter((entry) => entry.patterns.some((pattern) => pattern.test(text)))
        .map(({ number, name }) => ({ number, name }));
};
const assertNoProhibitedIngredients = (product) => {
    const matches = findProhibitedIngredients(product);
    if (matches.length)
        throw ApiError.badRequest(
            messages.MATERIAL_COMPLIANCE.PROHIBITED_PRODUCT(
                product.name || messages.MATERIAL_COMPLIANCE.MATERIAL,
                matches.map((entry) => entry.name).join(', '),
                LEGAL_BASIS,
            ),
        );
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
    if (!Array.isArray(details?.evidenceUrls) || !details.evidenceUrls.length)
        missing.push(messages.MATERIAL_COMPLIANCE.EVIDENCE_REQUIRED);
    if (typeof details?.containsAntibiotic !== 'boolean')
        missing.push(messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_CLASSIFICATION_REQUIRED);
    const prefix = /^((?:01|02|03))-\d{6}$/.exec(details?.registrationNumber ?? '')?.[1];
    const expectedPrefix = {
        feed: '01',
        environment: '02',
        dual_purpose: '03',
    }[details?.regulatoryType];
    // Validate recognized modern receipt formats without rejecting legitimate transitional legacy identifiers.
    if (prefix && expectedPrefix && prefix !== expectedPrefix)
        missing.push(messages.MATERIAL_COMPLIANCE.REGISTRATION_TYPE_MISMATCH);
    if (details?.containsAntibiotic === true && details.regulatoryType !== 'medicine')
        missing.push(messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_REQUIRES_MEDICINE);
    if (
        details?.regulatoryType === 'medicine' &&
        (details.withdrawalDays == null ||
            !Number.isFinite(Number(details.withdrawalDays)) ||
            Number(details.withdrawalDays) < 0)
    )
        missing.push(messages.MATERIAL_COMPLIANCE.WITHDRAWAL_REQUIRED);
    return missing;
};
const getMaterialSafety = (product) => {
    const matches = findProhibitedIngredients(product);
    if (matches.length)
        return {
            status: 'BANNED',
            reason: messages.MATERIAL_COMPLIANCE.PROHIBITED_INGREDIENTS(
                matches.map((entry) => entry.name).join(', '),
                LEGAL_BASIS,
            ),
        };
    const details = product.productCompliance;
    if (details?.complianceStatus === 'blocked')
        return {
            status: 'BANNED',
            reason: details.reviewNote || messages.MATERIAL_COMPLIANCE.PROFILE_BLOCKED,
        };
    if (details?.containsAntibiotic === true)
        return {
            status: 'TREATMENT_ONLY',
            reason: messages.MATERIAL_COMPLIANCE.ANTIBIOTIC_TREATMENT_ONLY,
        };
    if (
        details?.complianceStatus !== 'reviewed' ||
        !details.checkedBy ||
        !details.checkedAt ||
        complianceMissingFields(details).length
    ) {
        return {
            status: 'UNVERIFIED',
            reason: messages.MATERIAL_COMPLIANCE.DRAFT_PLAN_ONLY,
        };
    }
    return { status: 'VERIFIED', reason: null };
};

/** Templates are plans: allow drafts, but block prohibited ingredients, preventive antibiotics and incompatible uses. */
const assertMaterialSafety = (
    product,
    environment,
    _instructions,
    { requireReviewed = false, production = true } = {},
) => {
    assertNoProhibitedIngredients(product);
    const safety = getMaterialSafety(product);
    const details = product.productCompliance;
    const reviewed =
        details?.complianceStatus === 'reviewed' &&
        details.checkedBy &&
        details.checkedAt &&
        !complianceMissingFields(details).length;
    if (
        safety.status === 'BANNED' ||
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
    const details = product.productCompliance;
    if (details.complianceStatus === 'reviewed') {
        if (!product.manufacturerId && !product.manufacturer?.name?.trim()) {
            throw ApiError.badRequest(messages.MATERIAL_COMPLIANCE.MANUFACTURER_REVIEW_REQUIRED);
        }
        const missing = complianceMissingFields(details);
        if (missing.length)
            throw ApiError.badRequest(
                messages.MATERIAL_COMPLIANCE.MISSING_PROPOSAL_FIELDS(missing.join(', ')),
            );
    }
    // These stamps identify the server-checked submission, not an independent evidence review.
    return {
        complianceStatus: details.complianceStatus,
        checkedBy: details.complianceStatus === 'reviewed' ? accountId : null,
        checkedAt: details.complianceStatus === 'reviewed' ? now.toISOString() : null,
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
    const complete =
        Boolean(product.manufacturerId || product.manufacturer?.name?.trim()) &&
        complianceMissingFields(candidate).length === 0;
    const productCompliance = {
        ...candidate,
        complianceStatus: complete ? 'reviewed' : 'draft',
        reviewNote: complete ? candidate.reviewNote : null,
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
    normalize,
    findProhibitedIngredients,
    assertNoProhibitedIngredients,
    complianceMissingFields,
    getMaterialSafety,
    assertMaterialSafety,
    reviewProposal,
    assessTemplateProposal,
    productFromRecommendation,
};
