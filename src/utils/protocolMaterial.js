const { createHash } = require('crypto');
const { Prisma } = require('@prisma/client');
const ApiError = require('./ApiError');
const messages = require('../constants/messages');

/** Canonicalize material facts and decimal values used by revision fingerprints. */
const facts = product => {
    const compliance = product.compliance ?? product.productCompliance ?? {};
    const decimal = value => value == null ? null : new Prisma.Decimal(value).toString();
    return {
        id: product.id,
        name: product.name,
        description: product.description ?? null,
        category: product.category?.toUpperCase(),
        manufacturerId: product.manufacturerId,
        unit: product.unit?.toUpperCase(),
        conversionUnit: product.conversionUnit?.toUpperCase() ?? null,
        conversionQuantity: decimal(product.conversionQuantity),
        imageUrls: product.imageUrls ?? [],
        recommendationReason: product.recommendationReason ?? null,
        regulatoryType: compliance.regulatoryType ?? null,
        registrationNumber: compliance.registrationNumber ?? null,
        ingredientsText: compliance.ingredientsText ?? null,
        usageInstructions: compliance.usageInstructions ?? null,
        containsAntibiotic: compliance.containsAntibiotic ?? null,
        withdrawalDays: decimal(compliance.withdrawalDays),
        evidenceUrls: compliance.evidenceUrls ?? [],
    };
};

// Inventory quantities and alert thresholds do not change an Expert's prescription.
const materialRevision = product => createHash('sha256').update(JSON.stringify({
    ...facts(product), status: product.status,
})).digest('hex');

/** Reject selections whose catalog facts or availability changed after the Expert loaded them. */
const assertMaterialRevision = (product, expected) => {
    if (!product || expected !== materialRevision(product)) {
        throw ApiError.conflict(messages.INVENTORY.MATERIAL_SELECTION_CHANGED(product?.name));
    }
};

/** Compare prescription-relevant facts while excluding stock and alert thresholds. */
const materialFactsChanged = (before, after) => JSON.stringify(facts(before)) !== JSON.stringify(facts(after));

module.exports = { materialRevision, assertMaterialRevision, materialFactsChanged };
