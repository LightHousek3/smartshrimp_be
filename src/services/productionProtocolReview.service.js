const { Prisma } = require('@prisma/client');
const { ApiError, assertMaterialSafety, assertTemplateDose, requireCompleteInventoryProduct, productionProtocolV2: v2 } = require('../utils');
const { messages, PRODUCTION_PROTOCOL_LIMITS, PRODUCT_STATUS, PROTOCOL_STATUS, OPERATION_TYPE } = require('../constants');
const { cultureDay } = require('../utils/protocolTimeline');

const materialSelect = { id: true, farmId: true, name: true, description: true, category: true, status: true,
    unit: true, conversionUnit: true, conversionQuantity: true, manufacturerId: true, compliance: true,
    recommendationReason: true, imageUrls: true,
    manufacturer: { select: { id: true, name: true, ownerId: true, status: true, supplierType: true, address: true, contactName: true, phone: true, email: true } } };

const assertOperationalMaterial = (product, item, farmId, ownerId, protocol = {}) => {
    if (!product || product.status !== PRODUCT_STATUS.ACTIVE || product.farmId !== farmId
        || !product.manufacturer || product.manufacturer.ownerId !== ownerId
        || !['MANUFACTURER', 'BOTH'].includes(product.manufacturer.supplierType)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
    }
    assertMaterialSafety({ ...product, productCompliance: product.compliance }, item.mealNumber == null,
        item.instructions, { requireReviewed: true, production: protocol.protocolType !== 'TREATMENT' });
    requireCompleteInventoryProduct(product);
    if (['PACK', 'BOTTLE'].includes(product.unit) && (!product.conversionUnit
        || !Number.isFinite(Number(product.conversionQuantity)) || Number(product.conversionQuantity) <= 0)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
    }
    const firstDoc = protocol.protocolType === 'TREATMENT' && protocol.treatmentStartAt
        ? cultureDay(protocol.season.stockingDate, protocol.treatmentStartAt) + item.startDayOffset - 1 : item.startDayOffset;
    assertTemplateDose({ ...item, doseValue: Number(item.doseValue), endDay: firstDoc + item.endDayOffset - item.startDayOffset,
        dailyDoseIncrement: Number(item.dailyDoseIncrement ?? 0) }, product,
    firstDoc, item.mealNumber == null);
};

/** Labels may change; physical identity, conversion and approved professional facts require a new decision. */
const assertApprovedMaterial = (product, snapshot) => {
    const decimal = value => value == null ? null : new Prisma.Decimal(value).toString();
    const signature = value => {
        const profile = value.compliance ?? value.productCompliance ?? {};
        return JSON.stringify({ category: value.category?.toUpperCase(), manufacturerId: value.manufacturerId, unit: value.unit?.toUpperCase(),
            conversionUnit: value.conversionUnit?.toUpperCase() ?? null, conversionQuantity: decimal(value.conversionQuantity),
            regulatoryType: profile.regulatoryType ?? null, registrationNumber: profile.registrationNumber ?? null,
            ingredientsText: profile.ingredientsText ?? null, containsAntibiotic: profile.containsAntibiotic ?? null,
            usageInstructions: profile.usageInstructions ?? null, withdrawalDays: decimal(profile.withdrawalDays) });
    };
    if (!snapshot || signature(product) !== signature(snapshot)) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
};

/** Owner resolves catalogue identity, not a different technical prescription (BR-48/49). */
const assertSelectionMatches = (item, product, submittedItem) => {
    if (item.productId) {
        if (item.productId !== product.id) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
        const snapshot = submittedItem?.product ?? item.materialSnapshot;
        if (snapshot) assertApprovedMaterial(product, snapshot);
        return;
    }
    const proposed = item.recommendedProductDetails?.proposed;
    const sameText = (left, right) => String(left ?? '').trim().toLocaleLowerCase('vi') === String(right ?? '').trim().toLocaleLowerCase('vi');
    if (!proposed || !sameText(proposed.name, product.name)
        || item.recommendedManufacturerId && item.recommendedManufacturerId !== product.manufacturerId
        || !item.recommendedManufacturerId && (!sameText(proposed.manufacturer?.name, product.manufacturer?.name)
            || !sameText(proposed.manufacturer?.address, product.manufacturer?.address))) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
    }
    assertApprovedMaterial(product, { ...proposed, manufacturerId: item.recommendedManufacturerId ?? product.manufacturerId,
        compliance: proposed.productCompliance });
};

const reviews = async (client, protocol, ownerId) => {
    const items = await client.protocolItem.findMany({ where: { protocolId: protocol.id }, orderBy: { sequenceOrder: 'asc' },
        include: { product: { select: materialSelect } } });
    return items.map((item) => {
        if (v2.isV2(protocol)) v2.assertItemMetadata(item);
        let resolutionMessage = null;
        if (protocol.status === PROTOCOL_STATUS.PENDING_APPROVAL) {
            try { assertOperationalMaterial(item.product, item, protocol.season.pond.farmId, ownerId, protocol); }
            catch (error) { if (!(error instanceof ApiError)) throw error; resolutionMessage = error.message; }
        }
        const catalog = protocol.status === PROTOCOL_STATUS.PENDING_APPROVAL ? item.product : item.materialSnapshot ?? item.product;
        return { itemId: item.id, productId: item.productId,
        name: item.recommendedProductDetails?.proposed?.name ?? catalog?.name ?? item.recommendedProductName,
        operationType: item.operationType, doseUnit: item.doseUnit, doseBasis: item.doseBasis, doseValue: String(item.doseValue),
        mealNumber: item.mealNumber, plannedTime: item.plannedTime?.toISOString().slice(11, 23) ?? null,
        doseAnchorDay: item.doseAnchorDay ?? item.startDayOffset,
        requiresResolution: Boolean(resolutionMessage), resolutionMessage,
        recommendedManufacturerId: item.recommendedManufacturerId,
        proposed: item.recommendedProductDetails?.proposed ?? null,
        catalog: catalog ? JSON.parse(JSON.stringify(catalog)) : null,
        dailyDoseIncrement: String(item.dailyDoseIncrement ?? 0),
        firstDay: item.startDayOffset, lastDay: item.endDayOffset, repeatIntervalDays: item.repeatIntervalDays,
        recurrenceAnchorDay: item.recurrenceAnchorDay ?? item.startDayOffset,
    }; });
};

/** Resolve only existing catalog records; proposals and evidence remain immutable submission snapshots. */
const resolveForApproval = async (client, protocol, ownerId, selections = []) => {
    const items = await client.protocolItem.findMany({ where: { protocolId: protocol.id },
        orderBy: { sequenceOrder: 'asc' } });
    const selected = new Map(selections.map((entry) => [entry.itemId, entry.productId]));
    if (selected.size !== selections.length || selections.some((entry) => !items.some((item) => item.id === entry.itemId))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
    }
    const productIds = [...new Set(items.map((item) => selected.get(item.id) ?? item.productId).filter(Boolean))].sort();
    if (items.some((item) => !(selected.get(item.id) ?? item.productId))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_UNRESOLVED);
    }
    for (const id of productIds) await client.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR SHARE`;
    const products = await client.product.findMany({ where: { id: { in: productIds } }, select: materialSelect });
    const submission = await client.protocolStatusHistory.findFirst({ where: { protocolId: protocol.id, eventType: 'SUBMITTED' },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], select: { eventData: true } });
    for (const item of items) {
        const productId = selected.get(item.id) ?? item.productId;
        const product = products.find((entry) => entry.id === productId);
        assertOperationalMaterial(product, item, protocol.season.pond.farmId, ownerId, protocol);
        assertSelectionMatches(item, product, submission?.eventData?.snapshot?.items?.find(row => row.id === item.id));
        v2.assertItemMetadata(item);
        const details = item.recommendedProductDetails;
        await client.protocolItem.update({ where: { id: item.id }, data: { productId, materialSnapshot: JSON.parse(JSON.stringify(product)),
            ...(details && { recommendedProductDetails: { ...details, ownerOverrides: { productId, resolvedBy: ownerId, resolvedAt: new Date().toISOString() } } }),
        } });
    }
};

const options = async (client, ownerId, protocol, itemId, search = '') => {
    const item = await client.protocolItem.findFirst({ where: { id: itemId, protocolId: protocol.id } });
    if (!item) throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
    if (v2.isV2(protocol)) v2.assertItemMetadata(item);
    const where = { farmId: protocol.season.pond.farmId, status: PRODUCT_STATUS.ACTIVE,
        category: item.operationType === OPERATION_TYPE.FEEDING ? 'FEED' : item.operationType,

        manufacturer: { is: { ownerId, status: 'active', supplierType: { in: ['MANUFACTURER', 'BOTH'] } } },
        compliance: { is: { complianceStatus: 'reviewed', ...(protocol.protocolType !== 'TREATMENT' && { containsAntibiotic: false }), checkedBy: { not: null }, checkedAt: { not: null } } },

        ...(search && { name: { contains: search, mode: 'insensitive' } }) };
    const eligible = [];
    let cursor;
    // Apply eligibility before the visible limit; invalid first-page records must not hide later valid choices.
    while (eligible.length < PRODUCTION_PROTOCOL_LIMITS.materialOptions) {
        const rows = await client.product.findMany({ where, select: materialSelect,
            take: PRODUCTION_PROTOCOL_LIMITS.materialOptions, orderBy: [{ name: 'asc' }, { id: 'asc' }],
            ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
        for (const product of rows) {
            try {
                assertOperationalMaterial(product, item, protocol.season.pond.farmId, ownerId, protocol);
                assertSelectionMatches(item, product);
            }
            catch (error) { if (error instanceof ApiError) continue; throw error; }
            eligible.push({ id: product.id, name: product.name, unit: product.unit, manufacturerName: product.manufacturer.name,
                material: JSON.parse(JSON.stringify(product)) });
            if (eligible.length === PRODUCTION_PROTOCOL_LIMITS.materialOptions) break;
        }
        if (rows.length < PRODUCTION_PROTOCOL_LIMITS.materialOptions) break;
        cursor = rows.at(-1).id;
    }
    return eligible;
};

// Keep this projection in one module for approval, generator and material choice eligibility.
module.exports = { materialSelect, assertOperationalMaterial, assertApprovedMaterial, reviews, resolveForApproval, options,
    assertSelectionMatches, isV2: v2.isV2 };
