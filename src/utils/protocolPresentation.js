const { createHash } = require('crypto');
const v2 = require('./productionProtocolV2');

// PostgreSQL TIME is a wall-clock value, represented by Prisma on a fixed UTC date.
const timeText = value => value == null ? null : value.toISOString().slice(11, 23);
const viewId = (kind, itemId) => {
    const hash = createHash('sha256').update(`${kind}:${itemId}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

/** Group ordered database items before projecting fields or converting day offsets. */
const groupItems = (items, dayLabel = 'DOC') => {
    const stages = [];
    for (const entry of items) {
        let stage = stages.at(-1);
        const startDayOffset = entry.startDayOffset - 1;
        const endDayOffset = entry.endDayOffset - 1;
        if (!stage || stage.startDayOffset !== startDayOffset || stage.endDayOffset !== endDayOffset) {
            stage = {
                id: viewId('stage', entry.id),
                title: `${dayLabel} ${entry.startDayOffset}–${entry.endDayOffset}`,
                startDayOffset,
                endDayOffset,
                meals: [],
            };
            stages.push(stage);
        }
        let meal = stage.meals.at(-1);
        const planned = timeText(entry.plannedTime);
        if (!meal || meal.mealNumber !== entry.mealNumber || meal.plannedTime !== planned) {
            meal = { id: viewId('meal', entry.id), mealNumber: entry.mealNumber, plannedTime: planned, items: [] };
            stage.meals.push(meal);
        }
        meal.items.push(entry);
    }
    return stages;
};

const wireItem = entry => ({
    ...(entry.recommendedProductDetails && { recommendedProductDetails: entry.recommendedProductDetails,
        recommendedManufacturerId: entry.recommendedManufacturerId ?? null }),
    ...v2.v2WireItem(entry),
    id: entry.id,
    operationType: entry.operationType,
    productId: entry.productId,
    recommendedProductName: entry.recommendedProductName,
    recommendedCategory: entry.recommendedCategory,
    repeatIntervalDays: entry.repeatIntervalDays,
    doseBasis: entry.doseBasis,
    doseValue: String(entry.doseValue),
    doseUnit: entry.doseUnit,
    instructions: entry.instructions,
    dueAtMinutes: entry.dueAtMinutes ?? null,
    product: entry.product && {
        id: entry.product.id, name: entry.product.name, category: entry.product.category,
        unit: entry.product.unit, status: entry.product.status,
    },
});

const protocolStages = row => v2.protocolGroups(row,
    items => groupItems(items, row.protocolType === 'TREATMENT' ? 'Ngày điều trị' : 'DOC'))
    .map(stage => ({
        ...stage,
        meals: stage.meals.map(meal => ({ ...meal, items: meal.items.map(wireItem) })),
    }));

module.exports = { groupItems, wireItem, protocolStages };
