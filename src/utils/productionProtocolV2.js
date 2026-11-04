const { Prisma } = require('@prisma/client');
const config = require('../config');
const ApiError = require('./ApiError');
const { messages, httpStatus, PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

const v2Enabled = () => config.productionProtocol?.v2Enabled === true;
const templateApplyEnabled = () => v2Enabled() && config.productionProtocol?.templateApplyEnabled === true;
// Reading an existing V2 protocol must remain safe when its creation flags are disabled.
const isV2 = (row) => row.contentVersion === 2;
const invalidStoredContent = () => new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.PRODUCTION_PROTOCOL.STORED_CONTENT_INVALID);
const objectWithKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const doc = (value) => Number.isInteger(value) && value >= 1 && value <= PRODUCTION_PROTOCOL_LIMITS.maxDoc;
const timeText = (value) => value == null ? null : new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`).toISOString().slice(11, 23);

const assertItemMetadata = (item) => {
    if (!uuid(item.productionMealId) || item.dailyDoseIncrement == null || !doc(item.recurrenceAnchorDay)
        || !doc(item.doseAnchorDay) || item.recurrenceAnchorDay > item.startDayOffset || item.doseAnchorDay > item.startDayOffset) {
        throw invalidStoredContent();
    }
    const increment = new Prisma.Decimal(item.dailyDoseIncrement);
    if (!increment.isFinite() || increment.lt(0)) throw invalidStoredContent();
};

/** Stored group metadata contains no item copies; membership belongs to protocol_items. */
const assertStructure = (structure) => {
    if (!objectWithKeys(structure, ['structureVersion', 'stages']) || structure.structureVersion !== PRODUCTION_PROTOCOL_LIMITS.structureVersion
        || !Array.isArray(structure.stages) || structure.stages.length > PRODUCTION_PROTOCOL_LIMITS.stages) throw invalidStoredContent();
    const ids = new Set(), ranges = [];
    const identity = (id) => { if (!uuid(id) || ids.has(id.toLowerCase())) throw invalidStoredContent(); ids.add(id.toLowerCase()); };
    for (const [index, stage] of structure.stages.entries()) {
        if (!objectWithKeys(stage, ['id', 'startDayOfCulture', 'endDayOfCulture', 'sequenceOrder', 'meals'])) throw invalidStoredContent();
        identity(stage.id);
        if (!doc(stage.startDayOfCulture) || !doc(stage.endDayOfCulture) || stage.endDayOfCulture < stage.startDayOfCulture
            || stage.sequenceOrder !== index + 1 || !Array.isArray(stage.meals) || stage.meals.length > PRODUCTION_PROTOCOL_LIMITS.items) throw invalidStoredContent();
        ranges.push(stage);
        for (const [mealIndex, meal] of stage.meals.entries()) {
            if (!objectWithKeys(meal, ['id', 'mealNumber', 'plannedTime', 'sequenceOrder'])) throw invalidStoredContent();
            identity(meal.id);
            if (meal.sequenceOrder !== mealIndex + 1 || (meal.mealNumber !== null
                && (!Number.isInteger(meal.mealNumber) || meal.mealNumber < 1 || meal.mealNumber > 32767))
                || (meal.plannedTime !== null && (typeof meal.plannedTime !== 'string'
                    || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(meal.plannedTime)))) throw invalidStoredContent();
        }
    }
    ranges.sort((a, b) => a.startDayOfCulture - b.startDayOfCulture);
    if (ranges.some((stage, index) => index && stage.startDayOfCulture <= ranges[index - 1].endDayOfCulture)) throw invalidStoredContent();
    return structure;
};

const storedStructure = (stages) => assertStructure({ structureVersion: PRODUCTION_PROTOCOL_LIMITS.structureVersion,
    stages: stages.map((stage, index) => ({ id: stage.id, startDayOfCulture: stage.startDayOffset + 1,
        endDayOfCulture: stage.endDayOffset + 1, sequenceOrder: index + 1,
        meals: stage.meals.map((meal, mealIndex) => ({ id: meal.id, mealNumber: meal.mealNumber,
            plannedTime: timeText(meal.plannedTime), sequenceOrder: mealIndex + 1 })) })) });

const itemWindow = (item, stage) => {
    const first = item.firstDayOffset ?? stage.startDayOffset;
    const last = item.lastDayOffset ?? stage.endDayOffset;
    const recurrence = item.recurrenceAnchorOffset ?? first;
    const doseAnchor = item.doseAnchorOffset ?? first;
    if (![first, last, recurrence, doseAnchor].every(Number.isSafeInteger)
        || first < stage.startDayOffset || last > stage.endDayOffset || first > last
        || recurrence < 0 || recurrence > first || doseAnchor < 0 || doseAnchor > first) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.APPLICATION_DAYS);
    }
    const increment = new Prisma.Decimal(item.dailyDoseIncrement ?? 0);
    const finalDose = new Prisma.Decimal(item.doseValue).plus(increment.times(last - doseAnchor));
    if (increment.lt(0) || finalDose.gt('9999999999') || (increment.gt(0)
        && (item.operationType !== 'FEEDING' || item.doseBasis !== 'FIXED_QUANTITY'
            || item.repeatIntervalDays !== 1 || last > 28 || !['G', 'KG'].includes(item.doseUnit)))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.DAILY_INCREMENT);
    }
    return { first, last, recurrence, doseAnchor, increment };
};

/** One-based database DOC is shared by preview and materialization; rolling windows never reset anchors. */
const occursOn = (item, day) => {
    if (item.productionMealId != null) assertItemMetadata(item);
    return day >= item.startDayOffset && day <= item.endDayOffset
        && (day - (item.recurrenceAnchorDay ?? item.startDayOffset)) % item.repeatIntervalDays === 0;
};
const doseAtDay = (item, day) => {
    if (item.productionMealId != null) assertItemMetadata(item);
    return new Prisma.Decimal(item.doseValue).plus(new Prisma.Decimal(item.dailyDoseIncrement ?? 0)
        .times(day - (item.doseAnchorDay ?? item.startDayOffset)));
};
const v2WireItem = (entry) => entry.productionMealId != null ? {
    recommendedProductDetails: entry.recommendedProductDetails ?? null,
    recommendedManufacturerId: entry.recommendedManufacturerId ?? null,
    dailyDoseIncrement: String(entry.dailyDoseIncrement),
    firstDayOffset: entry.startDayOffset - 1,
    lastDayOffset: entry.endDayOffset - 1,
    recurrenceAnchorOffset: entry.recurrenceAnchorDay - 1,
    doseAnchorOffset: entry.doseAnchorDay - 1,
    materialSnapshot: entry.materialSnapshot ?? null,
} : {};

const protocolGroups = (row, legacyGroups) => {
    if (!isV2(row)) return legacyGroups(row.items);
    const structure = assertStructure(row.productionStructure), byMeal = new Map();
    for (const stage of structure.stages) for (const meal of stage.meals) byMeal.set(meal.id.toLowerCase(), { stage, meal, items: [] });
    if (row.items.length > PRODUCTION_PROTOCOL_LIMITS.items) throw invalidStoredContent();
    for (const item of row.items) {
        assertItemMetadata(item);
        const group = byMeal.get(item.productionMealId.toLowerCase());
        if (!group || item.startDayOffset < group.stage.startDayOfCulture || item.endDayOffset > group.stage.endDayOfCulture
            || item.mealNumber !== group.meal.mealNumber || (item.plannedTime?.toISOString().slice(11, 23) ?? null) !== group.meal.plannedTime) throw invalidStoredContent();
        group.items.push(item);
    }
    return structure.stages.map((stage) => ({ id: stage.id, startDayOffset: stage.startDayOfCulture - 1,
        endDayOffset: stage.endDayOfCulture - 1, meals: stage.meals.map((meal) => ({ id: meal.id,
            mealNumber: meal.mealNumber, plannedTime: meal.plannedTime, items: byMeal.get(meal.id.toLowerCase()).items })) }));
};

const normalizeProposal = (details) => {
    if (!details) return null;
    const proposed = JSON.parse(JSON.stringify(details.proposed));
    if (typeof proposed?.name !== 'string' || !proposed.name.trim() || proposed.name.length > 255
        || typeof proposed.category !== 'string' || !['feed', 'medicine', 'mineral', 'chemical', 'other'].includes(proposed.category.toLowerCase())
        || typeof proposed.unit !== 'string' || !['kg', 'g', 'l', 'ml', 'pack', 'bottle', 'pcs'].includes(proposed.unit.toLowerCase())
        || (proposed.description != null && (typeof proposed.description !== 'string' || proposed.description.length > 500))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
    }
    proposed.category = proposed.category.toLowerCase();
    proposed.unit = proposed.unit.toLowerCase();
    if (proposed.conversionUnit != null && typeof proposed.conversionUnit !== 'string') throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
    proposed.conversionUnit = proposed.conversionUnit?.toLowerCase() ?? null;
    if (['pack', 'bottle'].includes(proposed.unit) &&
        (!['kg', 'g', 'mg', 'l', 'ml', 'pcs'].includes(proposed.conversionUnit)
            || !Number.isFinite(Number(proposed.conversionQuantity)) || Number(proposed.conversionQuantity) <= 0)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
    }
    if ((proposed.productCompliance != null && (typeof proposed.productCompliance !== 'object' || Array.isArray(proposed.productCompliance)))
        || (proposed.manufacturer != null && (typeof proposed.manufacturer !== 'object' || Array.isArray(proposed.manufacturer)
            || typeof proposed.manufacturer.name !== 'string' || !proposed.manufacturer.name.trim()))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
    }
    const compliance = proposed.productCompliance ?? {};
    for (const field of ['complianceStatus', 'checkedBy', 'checkedAt', 'reviewNote']) delete compliance[field];
    proposed.productCompliance = compliance;
    return { proposed, ownerOverrides: null, review: { complianceStatus: 'draft', checkedBy: null, checkedAt: null } };
};

/** Legacy template rows have no stage IDs: connected ranges preserve every rule without inventing dates. */
const templateGroups = (items) => {
    const ranges = [];
    for (const item of [...items].sort((a, b) => a.startDayOfCulture - b.startDayOfCulture)) {
        const previous = ranges.at(-1);
        if (previous && item.startDayOfCulture <= previous.end) previous.end = Math.max(previous.end, item.endDayOfCulture);
        else ranges.push({ start: item.startDayOfCulture, end: item.endDayOfCulture });
    }
    // Sparse legacy rows may have more disconnected runs than original stages.
    // Merge only the display envelope; item dates and recurrence anchors remain untouched.
    if (ranges.length > PRODUCTION_PROTOCOL_LIMITS.stages) {
        const tail = ranges.splice(PRODUCTION_PROTOCOL_LIMITS.stages - 1);
        ranges.push({ start: tail[0].start, end: tail.at(-1).end });
    }
    return ranges.map(({ start, end }) => {
        const meals = [];
        for (const item of items.filter((row) => row.startDayOfCulture >= start && row.endDayOfCulture <= end)) {
            const time = item.plannedTime?.toISOString().slice(11, 23) ?? null;
            let meal = meals.find((row) => row.mealNumber === item.mealNumber && row.plannedTime === time);
            if (!meal) { meal = { mealNumber: item.mealNumber, plannedTime: time, items: [] }; meals.push(meal); }
            meal.items.push({ operationType: item.operationType, productId: item.productId,
                recommendedProductName: item.recommendedProductDetails?.proposed?.name ?? item.recommendedProductName ?? null,
                recommendedCategory: item.recommendedProductDetails?.proposed?.category?.toUpperCase() ?? item.recommendedCategory ?? null,
                recommendedProductDetails: item.recommendedProductDetails ?? null,
                recommendedManufacturerId: item.recommendedManufacturerId ?? null,
                doseBasis: item.doseBasis, doseValue: String(item.doseValue), doseUnit: item.doseUnit,
                dailyDoseIncrement: String(item.dailyDoseIncrement ?? 0), repeatIntervalDays: item.repeatIntervalDays,
                firstDayOffset: item.startDayOfCulture - 1, lastDayOffset: item.endDayOfCulture - 1,
                recurrenceAnchorOffset: item.startDayOfCulture - 1, doseAnchorOffset: item.startDayOfCulture - 1,
                instructions: item.instructions,
            });
        }
        return { startDayOffset: start - 1, endDayOffset: end - 1, meals };
    });
};

module.exports = { v2Enabled, templateApplyEnabled, isV2, assertItemMetadata, assertStructure, storedStructure,
    itemWindow, occursOn, doseAtDay, v2WireItem, protocolGroups, templateGroups, normalizeProposal };
