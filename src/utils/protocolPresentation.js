const structure = require('./protocolStructure');
const { materialRevision } = require('./protocolMaterial');
const { PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

/** Serialize exact dose text and retain snapshot revisions when live catalog facts change. */
const wireItem = (entry) => ({
    ...(entry.recommendedProductDetails && {
        recommendedProductDetails: entry.recommendedProductDetails,
        recommendedManufacturerId: entry.recommendedManufacturerId ?? null,
    }),
    ...structure.itemMetadata(entry),
    id: entry.id,
    operationType: entry.operationType,
    productId: entry.productId,
    ...(entry.productId && {
        productRevision: materialRevision(entry.materialSnapshot ?? entry.product ?? {}),
    }),
    repeatIntervalDays: entry.repeatIntervalDays,
    doseBasis: entry.doseBasis,
    doseValue: String(entry.doseValue),
    doseUnit: entry.doseUnit,
    instructions: entry.instructions,
    dueAtMinutes: entry.dueAtMinutes ?? PRODUCTION_PROTOCOL_LIMITS.defaultDueAtMinutes,
    product: entry.product && {
        id: entry.product.id,
        name: entry.product.name,
        category: entry.product.category,
        unit: entry.product.unit,
        status: entry.product.status,
        materialRevision: materialRevision(entry.materialSnapshot ?? entry.product),
        needsReview: Boolean(
            entry.materialSnapshot &&
                materialRevision(entry.materialSnapshot) !== materialRevision(entry.product),
        ),
    },
});

const protocolStages = (row) =>
    structure.protocolGroups(row).map((stage) => ({
        ...stage,
        title: `${row.protocolType === 'TREATMENT' ? 'Ngày điều trị' : 'DOC'} ${stage.startDayOffset + 1}–${stage.endDayOffset + 1}`,
        meals: stage.meals.map((meal) => ({ ...meal, items: meal.items.map(wireItem) })),
    }));

module.exports = { wireItem, protocolStages };
