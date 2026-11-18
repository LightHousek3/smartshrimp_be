const { Prisma } = require('@prisma/client');
const {
    ApiError,
    assertMaterialSafety,
    assertTemplateDose,
    protocolStructure: structure,
} = require('../utils');
const {
    messages,
    PRODUCTION_PROTOCOL_LIMITS,
    PRODUCT_STATUS,
    PROTOCOL_STATUS,
    OPERATION_TYPE,
} = require('../constants');
const { cultureDay } = require('../utils/protocolTimeline');

const materialSelect = {
    id: true,
    farmId: true,
    name: true,
    description: true,
    category: true,
    status: true,
    unit: true,
    conversionUnit: true,
    conversionQuantity: true,
    manufacturerId: true,
    compliance: true,
    recommendationReason: true,
    imageUrls: true,
    manufacturer: {
        select: {
            id: true,
            name: true,
            ownerId: true,
            status: true,
            supplierType: true,
            address: true,
            contactName: true,
            phone: true,
            email: true,
        },
    },
};

/** Reject materials outside the farm or dose routes incompatible with the prescription. */
const assertOperationalMaterial = (product, item, farmId, ownerId, protocol = {}) => {
    if (
        !product ||
        product.status !== PRODUCT_STATUS.ACTIVE ||
        product.farmId !== farmId ||
        !product.manufacturer ||
        product.manufacturer.status !== 'active' ||
        product.manufacturer.ownerId !== ownerId ||
        !['MANUFACTURER', 'BOTH'].includes(product.manufacturer.supplierType)
    ) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
    }
    assertMaterialSafety(
        { ...product, productCompliance: product.compliance },
        item.mealNumber == null,
        item.instructions,
        { production: protocol.protocolType !== 'TREATMENT' },
    );
    if (
        ['PACK', 'BOTTLE'].includes(product.unit) &&
        (!product.conversionUnit ||
            !Number.isFinite(Number(product.conversionQuantity)) ||
            Number(product.conversionQuantity) <= 0)
    ) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
    }
    const firstDoc =
        protocol.protocolType === 'TREATMENT' && protocol.treatmentStartAt
            ? cultureDay(protocol.season.stockingDate, protocol.treatmentStartAt) +
              item.startDayOffset -
              1
            : item.startDayOffset;
    assertTemplateDose(
        {
            ...item,
            doseValue: Number(item.doseValue),
            endDay: firstDoc + item.endDayOffset - item.startDayOffset,
            dailyDoseIncrement: Number(item.dailyDoseIncrement ?? 0),
        },
        product,
        firstDoc,
        item.mealNumber == null,
    );
};

/** Labels may change; physical identity, conversion and approved professional facts require a new decision. */
const assertApprovedMaterial = (product, snapshot) => {
    const decimal = (value) => (value == null ? null : new Prisma.Decimal(value).toString());
    const signature = (value) => {
        const profile = value.compliance ?? value.productCompliance ?? {};
        return JSON.stringify({
            category: value.category?.toUpperCase(),
            manufacturerId: value.manufacturerId,
            unit: value.unit?.toUpperCase(),
            conversionUnit: value.conversionUnit?.toUpperCase() ?? null,
            conversionQuantity: decimal(value.conversionQuantity),
            regulatoryType: profile.regulatoryType ?? null,
            registrationNumber: profile.registrationNumber ?? null,
            ingredientsText: profile.ingredientsText ?? null,
            containsAntibiotic: profile.containsAntibiotic ?? null,
            usageInstructions: profile.usageInstructions ?? null,
            withdrawalDays: decimal(profile.withdrawalDays ?? 0),
        });
    };
    if (!snapshot || signature(product) !== signature(snapshot))
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
};

/** Owner resolves catalogue identity, not a different technical prescription (BR-48/49). */
const assertSelectionMatches = (item, product, submittedItem) => {
    if (item.productId) {
        if (item.productId !== product.id)
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
        const snapshot = submittedItem?.product ?? item.materialSnapshot;
        if (snapshot) assertApprovedMaterial(product, snapshot);
        return;
    }
    const proposed = item.recommendedProductDetails?.proposed;
    const sameText = (left, right) =>
        String(left ?? '')
            .trim()
            .replace(/\s+/gu, ' ')
            .toLocaleLowerCase('vi') ===
        String(right ?? '')
            .trim()
            .replace(/\s+/gu, ' ')
            .toLocaleLowerCase('vi');
    if (
        !proposed ||
        !sameText(proposed.name, product.name) ||
        (item.recommendedManufacturerId &&
            item.recommendedManufacturerId !== product.manufacturerId) ||
        (!item.recommendedManufacturerId &&
            (!sameText(proposed.manufacturer?.name, product.manufacturer?.name) ||
                (proposed.manufacturer?.address &&
                    !sameText(proposed.manufacturer.address, product.manufacturer?.address))))
    ) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_CHANGED);
    }
    assertApprovedMaterial(product, {
        ...proposed,
        manufacturerId: item.recommendedManufacturerId ?? product.manufacturerId,
        compliance: proposed.productCompliance,
    });
};

/**
 * Return current submission proposals and material readiness without stock estimates.
 * A product linked before resubmission is a catalogue selection for this review;
 * its original recommendation remains stored for audit, not repeated in the Owner card.
 */
const reviews = async (client, protocol, ownerId) => {
    const items = await client.protocolItem.findMany({
        where: { protocolId: protocol.id },
        orderBy: { sequenceOrder: 'asc' },
        include: { product: { select: materialSelect } },
    });
    const submission = await client.protocolStatusHistory.findFirst({
        where: { protocolId: protocol.id, eventType: 'SUBMITTED' },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        select: { eventData: true },
    });
    const submittedItems = new Map(
        (submission?.eventData?.snapshot?.items ?? []).map(item => [item.id, item]),
    );
    const manufacturerIds = [
        ...new Set(items.map(item => item.recommendedManufacturerId).filter(Boolean)),
    ];
    const manufacturers = manufacturerIds.length
        ? await client.supplier.findMany({
            where: { id: { in: manufacturerIds }, ownerId },
            select: {
                id: true, name: true, address: true, phone: true,
                contactName: true, email: true, note: true, supplierType: true,
            },
        })
        : [];
    return items.map((item) => {
        structure.assertItemMetadata(item);
        let resolutionMessage = null;
        if (protocol.status === PROTOCOL_STATUS.PENDING_APPROVAL) {
            try {
                assertOperationalMaterial(
                    item.product,
                    item,
                    protocol.season.pond.farmId,
                    ownerId,
                    protocol,
                );
                assertSelectionMatches(item, item.product);
            } catch (error) {
                if (!(error instanceof ApiError)) throw error;
                resolutionMessage = error.message;
            }
        }
        const catalog =
            protocol.status === PROTOCOL_STATUS.PENDING_APPROVAL
                ? item.product
                : (item.materialSnapshot ?? item.product);
        // Use the submitted identity, not today's productId: creation in this
        // review must remain visible after refresh. Legacy snapshots may be absent.
        const proposed = submittedItems.get(item.id)?.productId
            ? null
            : item.recommendedProductDetails?.proposed;
        return {
            itemId: item.id,
            productId: item.productId,
            name: item.recommendedProductDetails?.proposed?.name ?? catalog?.name ?? 'Vật tư',
            operationType: item.operationType,
            doseUnit: item.doseUnit,
            doseBasis: item.doseBasis,
            doseValue: String(item.doseValue),
            mealNumber: item.mealNumber,
            plannedTime: item.plannedTime?.toISOString().slice(11, 23) ?? null,
            doseAnchorDay: item.doseAnchorDay ?? item.startDayOffset,
            requiresResolution: Boolean(resolutionMessage),
            resolutionMessage,
            recommendedManufacturerId: item.recommendedManufacturerId,
            proposed: proposed
                ? {
                    ...proposed,
                    ...(item.recommendedManufacturerId && {
                        manufacturer: manufacturers.find(row => row.id === item.recommendedManufacturerId) ?? null,
                    }),
                }
                : null,
            catalog: catalog ? JSON.parse(JSON.stringify(catalog)) : null,
            dailyDoseIncrement: String(item.dailyDoseIncrement ?? 0),
            firstDay: item.startDayOffset,
            lastDay: item.endDayOffset,
            repeatIntervalDays: item.repeatIntervalDays,
            recurrenceAnchorDay: item.recurrenceAnchorDay ?? item.startDayOffset,
        };
    });
};

/**
 * Lock the season and pending version before creating a proposed material.
 * The displayed revision prevents a stale form from linking to a changed prescription.
 */
const prepareCreation = async (client, ownerId, farmId, context) => {
    const where = {
        id: context.protocolId,
        submittedAt: { not: null },
        season: { pond: { farmId, farm: { ownerId } } },
    };
    const select = {
        id: true,
        status: true,
        updatedAt: true,
        submittedAt: true,
        protocolType: true,
        treatmentStartAt: true,
        seasonId: true,
        season: {
            select: {
                stockingDate: true,
                status: true,
                pond: { select: { farmId: true, farm: { select: { status: true } } } },
            },
        },
    };
    const owned = await client.protocol.findFirst({ where, select });
    if (!owned) throw ApiError.notFound(messages.PROTOCOL.NOT_FOUND);
    // Use the same season-first lock order as approval and schedule execution.
    await client.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${owned.seasonId}::uuid FOR UPDATE`;
    await client.$queryRaw`SELECT id FROM protocols WHERE id=${owned.id}::uuid FOR UPDATE`;
    const protocol = await client.protocol.findFirst({ where, select });
    if (
        !protocol ||
        protocol.status !== PROTOCOL_STATUS.PENDING_APPROVAL ||
        protocol.updatedAt.getTime() !== new Date(context.updatedAt).getTime()
    ) {
        throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
    }
    if (
        !['PLANNING', 'ACTIVE'].includes(protocol.season.status) ||
        protocol.season.pond.farm.status !== 'ACTIVE'
    ) {
        throw ApiError.forbidden(messages.PROTOCOL.CLOSED);
    }
    const items = await client.protocolItem.findMany({
        where: { protocolId: protocol.id },
        orderBy: { sequenceOrder: 'asc' },
    });
    const item = items.find(row => row.id === context.itemId);
    if (!item || !item.recommendedProductDetails?.proposed)
        throw ApiError.notFound(messages.PROTOCOL.PROPOSAL_NOT_FOUND);
    if (item.productId) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
    return { protocol, item, items };
};

/**
 * Link a newly saved material to every identical proposal in this version atomically.
 * Original Expert facts stay intact; creating catalogue records never creates stock.
 */
const linkCreatedMaterial = async (client, context, product, ownerId) => {
    const { protocol, item, items } = context;
    assertSelectionMatches(item, product);
    if (!item.recommendedManufacturerId) {
        const manufacturer = await client.supplier.findFirst({
            where: { id: product.manufacturerId, ownerId },
            select: { createdAt: true },
        });
        if (!manufacturer || manufacturer.createdAt < protocol.submittedAt)
            throw ApiError.badRequest(messages.PROTOCOL.PROPOSED_SUPPLIER_REQUIRED);
    }
    // Meal-specific notes and evidence links do not create a second catalogue identity.
    const matching = items.filter(row => {
        if (row.productId || !row.recommendedProductDetails?.proposed) return false;
        if ((row.recommendedManufacturerId ?? null) !== (item.recommendedManufacturerId ?? null))
            return false;
        try {
            assertSelectionMatches(row, product);
            return true;
        } catch (error) {
            if (error instanceof ApiError && error.statusCode === 409) return false;
            throw error;
        }
    });
    for (const row of matching) {
        structure.assertItemMetadata(row);
        assertSelectionMatches(row, product);
        assertOperationalMaterial(product, row, protocol.season.pond.farmId, ownerId, protocol);
    }
    const linked = await client.protocolItem.updateMany({
        where: { protocolId: protocol.id, id: { in: matching.map(row => row.id) }, productId: null },
        data: { productId: product.id, materialSnapshot: JSON.parse(JSON.stringify(product)) },
    });
    if (linked.count !== matching.length) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
    const changed = await client.protocol.updateMany({
        where: {
            id: protocol.id,
            status: PROTOCOL_STATUS.PENDING_APPROVAL,
            // PostgreSQL stores microseconds while the client revision carries milliseconds.
            updatedAt: {
                gte: protocol.updatedAt,
                lt: new Date(protocol.updatedAt.getTime() + 1),
            },
        },
        data: { updatedAt: new Date(Math.max(Date.now(), protocol.updatedAt.getTime() + 1)) },
    });
    if (changed.count !== 1) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
};

/** Resolve only existing catalog records; proposals and evidence remain immutable submission snapshots. */
const resolveForApproval = async (client, protocol, ownerId, selections = []) => {
    const items = await client.protocolItem.findMany({
        where: { protocolId: protocol.id },
        orderBy: { sequenceOrder: 'asc' },
    });
    const selected = new Map(selections.map((entry) => [entry.itemId, entry.productId]));
    if (
        selected.size !== selections.length ||
        selections.some((entry) => !items.some((item) => item.id === entry.itemId))
    ) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
    }
    const productIds = [
        ...new Set(items.map((item) => selected.get(item.id) ?? item.productId).filter(Boolean)),
    ].sort();
    // New proposals must be created and linked before the separate approval decision.
    // A legacy selection payload cannot bypass creation or replace the Expert's material.
    if (items.some(item =>
        !item.productId || (selected.has(item.id) && selected.get(item.id) !== item.productId),
    )) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_UNRESOLVED);
    }
    for (const id of productIds)
        await client.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR SHARE`;
    const products = await client.product.findMany({
        where: { id: { in: productIds } },
        select: materialSelect,
    });
    const submission = await client.protocolStatusHistory.findFirst({
        where: { protocolId: protocol.id, eventType: 'SUBMITTED' },
        orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
        select: { eventData: true },
    });
    for (const item of items) {
        const productId = selected.get(item.id) ?? item.productId;
        const product = products.find((entry) => entry.id === productId);
        assertOperationalMaterial(product, item, protocol.season.pond.farmId, ownerId, protocol);
        assertSelectionMatches(
            item,
            product,
            submission?.eventData?.snapshot?.items?.find((row) => row.id === item.id),
        );
        structure.assertItemMetadata(item);
        await client.protocolItem.update({
            where: { id: item.id },
            data: {
                productId,
                materialSnapshot: JSON.parse(JSON.stringify(product)),
            },
        });
    }
};

/** Filter eligible catalog matches before applying the visible selection limit. */
const options = async (client, ownerId, protocol, itemId, search = '') => {
    const item = await client.protocolItem.findFirst({
        where: { id: itemId, protocolId: protocol.id },
    });
    if (!item) throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
    structure.assertItemMetadata(item);
    const where = {
        farmId: protocol.season.pond.farmId,
        status: PRODUCT_STATUS.ACTIVE,
        category: item.operationType === OPERATION_TYPE.FEEDING ? 'FEED' : item.operationType,

        manufacturer: {
            is: { ownerId, status: 'active', supplierType: { in: ['MANUFACTURER', 'BOTH'] } },
        },
        compliance: {
            is: {
                ...(protocol.protocolType !== 'TREATMENT' && { containsAntibiotic: false }),
                checkedBy: { not: null },
                checkedAt: { not: null },
            },
        },

        ...(search && { name: { contains: search, mode: 'insensitive' } }),
    };
    const eligible = [];
    let cursor;
    // Apply eligibility before the visible limit; invalid first-page records must not hide later valid choices.
    while (eligible.length < PRODUCTION_PROTOCOL_LIMITS.materialOptions) {
        const rows = await client.product.findMany({
            where,
            select: materialSelect,
            take: PRODUCTION_PROTOCOL_LIMITS.materialOptions,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        });
        for (const product of rows) {
            try {
                assertOperationalMaterial(
                    product,
                    item,
                    protocol.season.pond.farmId,
                    ownerId,
                    protocol,
                );
                assertSelectionMatches(item, product);
            } catch (error) {
                if (error instanceof ApiError) continue;
                throw error;
            }
            eligible.push({
                id: product.id,
                name: product.name,
                unit: product.unit,
                manufacturerName: product.manufacturer.name,
                material: JSON.parse(JSON.stringify(product)),
            });
            if (eligible.length === PRODUCTION_PROTOCOL_LIMITS.materialOptions) break;
        }
        if (rows.length < PRODUCTION_PROTOCOL_LIMITS.materialOptions) break;
        cursor = rows.at(-1).id;
    }
    return eligible;
};

// Keep this projection in one module for approval, generator and material choice eligibility.
module.exports = {
    materialSelect,
    assertOperationalMaterial,
    assertApprovedMaterial,
    reviews,
    resolveForApproval,
    options,
    assertSelectionMatches,
    prepareCreation,
    linkCreatedMaterial,
};
