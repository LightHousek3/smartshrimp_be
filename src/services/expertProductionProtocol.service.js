const {
    Prisma,
    ProductionProtocolTemplateStatus: TemplateStatus,
} = require('@prisma/client');
const { createHash, randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const config = require('../config');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError, productionProtocolV2: v2, assertMaterialSafety, assertTemplateDose, productFromRecommendation, assertProtocolHarvestCoverage } = require('../utils');
const { hasOverlappingStages, isProductionProtocolDoseValid } = require('../utils/productionProtocol');
const {
    messages,
    FARM_STATUS,
    NOTIFICATION_TYPE,
    PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES,
    PRODUCTION_PROTOCOL_WRITABLE_SEASONS,
    httpStatus,
} = require('../constants');

const PRODUCT_SELECT = {
    id: true,
    name: true,
    category: true,
    unit: true,
    conversionQuantity: true,
    conversionUnit: true,
    status: true,
    farmId: true,
    description: true,
    recommendationReason: true,
    imageUrls: true,
    manufacturerId: true,
    manufacturer: { select: { id: true, name: true, status: true, supplierType: true, ownerId: true, address: true, contactName: true, phone: true, email: true } },
    compliance: true,
};
const protocolInclude = () => ({
    items: {
        orderBy: { sequenceOrder: 'asc' },
        include: { product: { select: PRODUCT_SELECT } },
    },
});

/** Fail closed until the existing-table storage and its deferred integrity checks are installed. */
const assertV2Ready = async (tx) => {
    if (!v2.v2Enabled()) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.V2_REQUIRED);
    const [result] = await tx.$queryRaw`SELECT
        (SELECT count(*) FROM (VALUES
            ('protocols','content_version','smallint',true),
            ('protocols','source_template_version_no','integer',false),
            ('protocols','source_template_snapshot','jsonb',false),
            ('protocols','production_structure','jsonb',false),
            ('protocol_items','production_meal_id','uuid',false),
            ('protocol_items','daily_dose_increment','numeric(14,4)',false),
            ('protocol_items','recurrence_anchor_day','integer',false),
            ('protocol_items','dose_anchor_day','integer',false),
            ('protocol_items','material_snapshot','jsonb',false)
        ) wanted(table_name,column_name,type_name,not_null)
        JOIN pg_class c ON c.relname=wanted.table_name JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=wanted.column_name AND NOT a.attisdropped
        WHERE format_type(a.atttypid,a.atttypmod)=wanted.type_name AND a.attnotnull=wanted.not_null)=9
        AND (SELECT count(*) FROM pg_constraint WHERE convalidated AND contype='c' AND
            (conrelid='public.protocols'::regclass AND conname='protocols_production_storage_check'
             OR conrelid='public.protocol_items'::regclass AND conname IN ('protocol_items_production_metadata_check','protocol_items_production_dose_rule_check')))=3
        AND to_regprocedure('public.production_protocol_structure_valid(jsonb)') IS NOT NULL
        AND to_regprocedure('public.validate_production_protocol_storage()') IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND tgdeferrable AND tginitdeferred AND
            (tgrelid='public.protocols'::regclass AND tgname='production_protocol_structure_check'
             OR tgrelid='public.protocol_items'::regclass AND tgname='production_protocol_item_storage_check'))=2 AS ready`;
    if (!result?.ready) throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.PRODUCTION_PROTOCOL.SCHEMA_NOT_READY);
};
const isWritable = (season) => PRODUCTION_PROTOCOL_WRITABLE_SEASONS.includes(season.status)
    && season.currentAssignment && season.pond.farm.status === FARM_STATUS.ACTIVE;
const mapError = (error) => {
    if (['P2002', 'P2034', 'P2025', 'P2003', 'P2028'].includes(error.code)
        || (error.code === 'P2010' && ['40001', '40P01', '55P03'].includes(error.meta?.code))) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    throw error;
};
/**
 * Keep protocol content and status history atomic; surface concurrent writes as conflicts.
 */
const transaction = async (callback) => {
    const notifications = [];
    try {
        const result = await prisma.$transaction((tx) => callback(tx, notifications), {
            isolationLevel: 'Serializable',
            maxWait: 5000,
            timeout: config.productionProtocol.transactionTimeoutMs,
        });
        // Persisted notifications remain readable even if realtime delivery is unavailable.
        for (const notification of notifications) {
            try {
                emitNotification(notification.accountId, 'notification:new', { id: notification.id });
            } catch (_) {
                logger.warn('Protocol notification realtime delivery failed after commit.');
            }
        }
        return result;
    } catch (error) {
        return mapError(error);
    }
};

/**
 * Resolve the active expert's owner and assignment scope inside the caller's transaction.
 * Historical assignments allow reads of ended seasons; writes require a current assignment.
 */
const scope = async (tx, accountId, seasonId, write = false) => {
    // Prisma has no row-lock API. Parameterized locks coordinate with existing UPDATE writers,
    // including account revocation and assignment replacement; all reads remain on this tx.
    if (write) {
        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
    }
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            role: true,
            status: true,
            managedByOwnerId: true,
        },
    });
    if (!account || account.status !== 'ACTIVE' || account.role !== 'EXPERT') {
        throw ApiError.forbidden(messages.PRODUCTION_PROTOCOL.EXPERT_INACTIVE);
    }
    const season = await tx.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: {
            id: true,
            name: true,
            status: true,
            shrimpType: true,
            initialQuantity: true,
            stockingDate: true,
            expectedEndDate: true,
            actualEndDate: true,
            pond: {
                select: {
                    id: true,
                    name: true,
                    volumeM3: true,
                    farm: {
                        select: {
                            id: true,
                            name: true,
                            ownerId: true,
                            status: true,
                        },
                    },
                },
            },
        },
    });
    if (!season || season.pond.farm.ownerId !== account.managedByOwnerId) {
        throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
    }
    if (write) {
        const farmId = season.pond.farm.id;
        const pondId = season.pond.id;
        await tx.$queryRaw`SELECT id FROM farms WHERE id = ${farmId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM ponds WHERE id = ${pondId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM season_personnel_assignments
            WHERE season_id = ${seasonId}::uuid AND account_id = ${accountId}::uuid
              AND role = 'expert' AND unassigned_at IS NULL FOR SHARE`;
        // Recheck the farm under the write locks before granting a mutation.
        const farm = await tx.farm.findFirst({
            where: { id: farmId, ownerId: account.managedByOwnerId },
            select: { status: true },
        });
        if (!farm) throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
        season.pond.farm.status = farm.status;
    }
    const assignments = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId,
            accountId,
            role: 'EXPERT',
        },
        select: { unassignedAt: true },
    });
    const currentAssignment = assignments.some((entry) => entry.unassignedAt === null);
    const historicalRead = ['COMPLETED', 'CANCELLED'].includes(season.status) && assignments.length > 0;
    if (!currentAssignment && !historicalRead) {
        throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
    }
    const result = {
        ...season,
        currentAssignment,
    };
    if (write && !isWritable(result)) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
    }
    return result;
};
/** Only production protocols belonging to the scoped season may enter this workflow. */
const findProtocol = async (tx, seasonId, protocolId) => {
    const row = await tx.protocol.findFirst({
        where: {
            id: protocolId,
            seasonId,
            protocolType: 'PRODUCTION',
            diseaseCaseId: null,
        },
        include: protocolInclude(),
    });
    if (!row) {
        throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
    }
    return row;
};
/** Successors and generated schedules make protocol content immutable in this editor. */
const blockers = async (tx, row) => {
    const [successor, schedules] = await Promise.all([
        tx.protocol.count({ where: { supersedesProtocolId: row.id } }),
        tx.operationSchedule.count({ where: { protocolItem: { protocolId: row.id } } }),
    ]);
    return successor > 0 || schedules > 0;
};
// The fixed UTC date carries a farm wall-clock TIME value without shifting its hour.
const plannedTime = (value) => value == null ? null : new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
const timeText = (value) => value == null ? null : value.toISOString().slice(11, 23);
// These are view identities, not persisted stage/meal rows. Contiguous runs preserve
// the original flat sequence even when the same range/time appears again later.
const viewId = (kind, itemId) => {
    const hash = createHash('sha256').update(`${kind}:${itemId}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
/**
 * Derive stage/meal views from ordered flat items without introducing persisted group IDs.
 * Convert one-based database DOC values to the zero-based offsets expected by the API.
 */
const groupItems = (items) => {
    const stages = [];
    for (const entry of items) {
        let stage = stages.at(-1);
        // API offsets are zero-based; protocol_items stores one-based DOC values.
        const startDayOffset = entry.startDayOffset - 1;
        const endDayOffset = entry.endDayOffset - 1;
        if (!stage || stage.startDayOffset !== startDayOffset || stage.endDayOffset !== endDayOffset) {
            stage = {
                id: viewId('stage', entry.id),
                title: `DOC ${entry.startDayOffset}–${entry.endDayOffset}`,
                startDayOffset,
                endDayOffset,
                meals: [],
            };
            stages.push(stage);
        }
        let meal = stage.meals.at(-1);
        const planned = timeText(entry.plannedTime);
        if (!meal || meal.mealNumber !== entry.mealNumber || meal.plannedTime !== planned) {
            meal = {
                id: viewId('meal', entry.id),
                mealNumber: entry.mealNumber,
                plannedTime: planned,
                items: [],
            };
            stage.meals.push(meal);
        }
        meal.items.push(entry);
    }
    return stages;
};
// Hash persisted content only; catalog labels/status can change independently.
const revisionOf = (row) => {
    const project = (value, names) => Object.fromEntries(names.map(name => [name, value[name] ?? null]));
    const canonical = (value) => {
        if (value?.toJSON) return canonical(value.toJSON());
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        return value;
    };
    const header = project(row, ['id', 'protocolType', 'seasonId', 'diseaseCaseId', 'sourceTemplateId', 'versionNo',
        'supersedesProtocolId', 'title', 'summary', 'allowedVariancePct', 'rollingWindowDays', 'status', 'createdBy',
        'submittedAt', 'reviewedBy', 'reviewedAt', 'rejectionReason', 'supersededAt', 'abortReason', 'abortedBy', 'abortedAt',
        'createdAt', 'updatedAt', 'sourceTemplateVersionNo', 'sourceTemplateSnapshot', 'productionStructure']);
    header.contentVersion = row.contentVersion ?? 1;
    const items = [...row.items].sort((a, b) => a.sequenceOrder - b.sequenceOrder || a.id.localeCompare(b.id)).map(item => project(item,
        ['id', 'protocolId', 'operationType', 'productId', 'recommendedProductName', 'recommendedCategory', 'recommendedProductDetails',
            'recommendedManufacturerId', 'startDayOffset', 'endDayOffset', 'repeatIntervalDays', 'mealNumber', 'plannedTime',
            'doseBasis', 'doseValue', 'doseUnit', 'instructions', 'sequenceOrder', 'createdAt', 'updatedAt', 'productionMealId',
            'dailyDoseIncrement', 'recurrenceAnchorDay', 'doseAnchorDay', 'materialSnapshot']));
    return createHash('sha256').update(JSON.stringify(canonical({ ...header, items }))).digest('hex');
};
// The reference DB already owns this table; Prisma's baseline has no delegate.
// Parameterized SQL avoids changing schema.prisma solely to access existing audit data.
const history = async (tx, protocolId) => {
    const rows = await tx.$queryRaw`SELECT id, protocol_id AS "protocolId",
        from_status::text AS "fromStatus", to_status::text AS "toStatus",
        changed_by AS "changedBy", reason, changed_at AS "changedAt"
        FROM protocol_status_history WHERE protocol_id = ${protocolId}::uuid
        ORDER BY changed_at, id`;
    return rows.map((entry) => ({
        ...entry,
        fromStatus: entry.fromStatus?.toUpperCase() || null,
        toStatus: entry.toStatus.toUpperCase(),
    }));
};
const appendHistory = (tx, protocolId, fromStatus, toStatus, accountId, reason = null) => tx.$executeRaw`
    INSERT INTO protocol_status_history (protocol_id, from_status, to_status, changed_by, reason)
    VALUES (${protocolId}::uuid, ${fromStatus}::protocol_status, ${toStatus}::protocol_status, ${accountId}::uuid, ${reason})`;
const wireItem = (entry) => ({
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
    product: entry.product && {
        id: entry.product.id,
        name: entry.product.name,
        category: entry.product.category,
        unit: entry.product.unit,
        status: entry.product.status,
    },
});

const copyItem = (entry) => {
    const fields = wireItem(entry);
    delete fields.id;
    delete fields.product;
    delete fields.materialSnapshot;
    return fields;
};
const wireDetail = (row, season, blocked, statusHistory) => ({
    id: row.id,
    seasonId: row.seasonId,
    protocolType: row.protocolType,
    versionNo: row.versionNo,
    supersedesProtocolId: row.supersedesProtocolId,
    contentVersion: row.contentVersion ?? 1,
    sourceTemplateVersionNo: row.sourceTemplateVersionNo ?? null,
    sourceTemplateSnapshot: row.sourceTemplateSnapshot ?? null,
    sourceTemplateId: row.sourceTemplateId,
    title: row.title,
    summary: row.summary,
    status: row.status,
    allowedVariancePct: String(row.allowedVariancePct),
    rollingWindowDays: row.rollingWindowDays,
    revision: revisionOf(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    rejectionReason: row.rejectionReason,
    stages: v2.protocolGroups(row, groupItems).map((stage) => ({
        ...stage,
        meals: stage.meals.map((meal) => ({
            ...meal,
            items: meal.items.map(wireItem),
        })),
    })),
    ungroupedItems: [],
    statusHistory,
    availableActions: {
        submit: Boolean(isWritable(season) && PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) && !blocked && row.items.length),
        update: Boolean(isWritable(season) && PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) && !blocked),
        cancel: Boolean(isWritable(season) && row.status === 'DRAFT' && !blocked),
    },
});
/**
 * Get season context and creation eligibility without exposing the farm owner's account ID.
 */
const getSeason = (accountId, seasonId) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const [approved, inProgress] = await Promise.all([
        tx.protocol.findFirst({
            where: {
                seasonId,
                protocolType: 'PRODUCTION',
                status: 'APPROVED',
            },
            select: {
                id: true,
                title: true,
                versionNo: true,
                reviewedAt: true,
            },
        }),
        tx.protocol.count({
            where: {
                seasonId,
                protocolType: 'PRODUCTION',
                status: { in: PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES },
            },
        }),
    ]);
    const { currentAssignment, ...data } = season;
    return {
        ...data,
        initialQuantity: data.initialQuantity == null ? null : String(data.initialQuantity),
        pond: {
            ...data.pond,
            volumeM3: data.pond.volumeM3 == null ? null : String(data.pond.volumeM3),
            farm: {
                id: data.pond.farm.id,
                name: data.pond.farm.name,
            },
        },
        authoringVersion: v2.v2Enabled() ? 2 : 1,
        approvedProductionProtocol: approved,
        availableActions: {
            create: Boolean(currentAssignment && isWritable(season) && !inProgress),
        },
    };
});
/**
 * List protocol versions with revision tokens and actions evaluated from current dependencies.
 */
const list = (accountId, seasonId, { page = 1, limit = 20 } = {}) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const where = {
        seasonId,
        protocolType: 'PRODUCTION',
        diseaseCaseId: null,
    };
    const [totalResults, rows] = await Promise.all([
        tx.protocol.count({ where }),
        tx.protocol.findMany({
            where,
            orderBy: { versionNo: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: protocolInclude(),
        }),
    ]);
    const data = await Promise.all(rows.map(async (row) => {
        const blocked = await blockers(tx, row);
        return {
            id: row.id,
            title: row.title,
            versionNo: row.versionNo,
            status: row.status,
            revision: revisionOf(row),
            updatedAt: row.updatedAt,
            submittedAt: row.submittedAt,
            reviewedAt: row.reviewedAt,
            rejectionReason: row.rejectionReason,
            stageCount: v2.protocolGroups(row, groupItems).length,
            itemCount: row.items.length,
            availableActions: {
                submit: Boolean(isWritable(season) && PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) && !blocked && row.items.length),
                view: true,
                update: Boolean(isWritable(season) && PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) && !blocked),
                cancel: Boolean(isWritable(season) && row.status === 'DRAFT' && !blocked),
            },
        };
    }));
    return {
        data,
        meta: {
            page,
            limit,
            totalResults,
        },
    };
});
/** Return scoped protocol content and audit history from the same transaction snapshot. */
const detail = (accountId, seasonId, protocolId) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const row = await findProtocol(tx, seasonId, protocolId);
    return wireDetail(row, season, await blockers(tx, row), await history(tx, row.id));
});
/** Only active products in the season's farm are eligible for new catalog selections. */
const catalog = (accountId, seasonId, {
    search = '', page = 1, limit = 50,
} = {}) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const where = {
        farmId: season.pond.farm.id,
        status: 'ACTIVE',
        ...(search && {
            name: {
                contains: search,
                mode: 'insensitive',
            },
        }),
    };
    const [totalResults, products] = await Promise.all([
        tx.product.count({ where }), tx.product.findMany({
            where,
            select: PRODUCT_SELECT,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);
    return {
        data: products.map((product) => ({
            ...product,
            conversionQuantity: product.conversionQuantity == null ? null : String(product.conversionQuantity),
        })),
        meta: {
            page,
            limit,
            totalResults,
        },
    };
});

const unitFamily = (unit) => ({
    KG: 'mass',
    G: 'mass',
    MG: 'mass',
    L: 'volume',
    ML: 'volume',
}[unit] || unit);
/**
 * Validate inclusive day ranges, existing identities, dose rules and product compatibility.
 * Retained inactive products may stay in a draft; submission revalidates them as new selections.
 */
const validateGraph = async (tx, season, stages, current, contentVersion = 1) => {
    if (contentVersion === 2) await assertV2Ready(tx);
    else if (stages.some(stage => !stage.meals.length || stage.meals.some(meal => !meal.items.length || meal.items.some(item => item.dailyDoseIncrement != null || item.recommendedProductDetails != null || item.firstDayOffset != null)))) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.V2_REQUIRED);
    }
    if (hasOverlappingStages(stages)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.STAGE_OVERLAP);
    }
    assertProtocolHarvestCoverage(stages, season);
    const groups = current ? v2.protocolGroups(current, groupItems) : [];
    const existingStages = new Set(groups.map((stage) => stage.id));
    const existingMeals = new Set(groups.flatMap((stage) => stage.meals.map((meal) => meal.id)));
    const oldItems = new Map(current?.items.map((entry) => [entry.id, entry]));
    const allIds = new Set();
    const checkId = (id, existing) => {
        if (id && (!existing.has(id) || allIds.has(id))) {
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.ID);
        }
        if (id) {
            allIds.add(id);
        }
    };
    const ids = [...new Set(stages.flatMap((stage) => stage.meals.flatMap((meal) => meal.items.map((entry) => entry.productId))).filter(Boolean))];
    // Prevent an active product becoming inactive or moving farms while a draft is written.
    for (const id of [...ids].sort()) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid FOR SHARE`;
    }
    const products = await tx.product.findMany({
        where: { id: { in: ids } },
        select: PRODUCT_SELECT,
    });
    const byId = new Map(products.map((product) => [product.id, product]));
    for (const stage of stages) {
        checkId(stage.id, existingStages);
        for (const meal of stage.meals) {
            checkId(meal.id, existingMeals);
            for (const entry of meal.items) {
                checkId(entry.id, oldItems);
                const window = contentVersion === 2 ? v2.itemWindow(entry, stage) : null;
                if (contentVersion !== 2 && !isProductionProtocolDoseValid(entry, stage.startDayOffset)) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.DOSE);
                }
                if (contentVersion === 2 && entry.recommendedProductDetails) {
                    entry.recommendedProductDetails = v2.normalizeProposal(entry.recommendedProductDetails);
                    const proposal = productFromRecommendation(entry.recommendedProductDetails);
                    const proposedManufacturerId = entry.recommendedProductDetails.proposed.manufacturerId;
                    if (entry.recommendedManufacturerId && proposedManufacturerId && entry.recommendedManufacturerId !== proposedManufacturerId) {
                        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
                    }
                    entry.recommendedManufacturerId = entry.recommendedManufacturerId ?? proposedManufacturerId ?? null;
                    entry.recommendedProductName = proposal.name;
                    entry.recommendedCategory = proposal.category;
                    assertMaterialSafety(proposal, meal.mealNumber == null, entry.instructions);
                    assertTemplateDose({ ...entry, endDay: window.last + 1, doseValue: Number(entry.doseValue),
                        dailyDoseIncrement: Number(entry.dailyDoseIncrement ?? 0) }, proposal, window.first + 1, meal.mealNumber == null);
                    if (entry.recommendedManufacturerId) {
                        const manufacturer = await tx.supplier.findFirst({ where: { id: entry.recommendedManufacturerId,
                            ownerId: season.pond.farm.ownerId, status: 'active', supplierType: { in: ['MANUFACTURER', 'BOTH'] } }, select: { id: true } });
                        if (!manufacturer) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION);
                    }
                }
                if (!entry.productId) {
                    if (contentVersion === 2 && !entry.recommendedProductDetails) {
                        assertTemplateDose({ ...entry, endDay: window.last + 1, doseValue: Number(entry.doseValue),
                            dailyDoseIncrement: Number(entry.dailyDoseIncrement ?? 0) },
                        { category: entry.recommendedCategory ?? (entry.operationType === 'FEEDING' ? 'FEED' : entry.operationType), unit: entry.doseUnit },
                        window.first + 1, meal.mealNumber == null);
                    }
                    continue;
                }
                const product = byId.get(entry.productId);
                const unchanged = oldItems.get(entry.id)?.productId === entry.productId;
                if (!product || product.farmId !== season.pond.farm.id || (!unchanged && product.status !== 'ACTIVE')) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
                }
                const operationType = product.category === 'FEED' ? 'FEEDING' : product.category;
                if (entry.operationType !== operationType) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
                }
                if (contentVersion === 2) {
                    assertMaterialSafety({ ...product, productCompliance: product.compliance }, meal.mealNumber == null, entry.instructions);
                    assertTemplateDose({ ...entry, endDay: window.last + 1, doseValue: Number(entry.doseValue),
                        dailyDoseIncrement: Number(entry.dailyDoseIncrement ?? 0) }, product, window.first + 1, meal.mealNumber == null);
                    entry._materialSnapshot = JSON.parse(JSON.stringify(product));
                }
                const baseUnit = Number(product.conversionQuantity) > 0 && product.conversionUnit ? product.conversionUnit : product.unit;
                if (entry.doseUnit !== product.unit && unitFamily(entry.doseUnit) !== unitFamily(baseUnit)) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
                }
            }
        }
    }
};
/**
 * Replace the validated graph while retaining item identities and unique sequence keys.
 * Writes use the caller's transaction and convert API offsets to one-based database DOC.
 */
const persistGraph = async (tx, protocolId, stages, current, contentVersion = 1) => {
    if (contentVersion === 2) {
        for (const stage of stages) {
            stage.id ??= randomUUID();
            for (const meal of stage.meals) meal.id ??= randomUUID();
        }
        await tx.protocol.update({ where: { id: protocolId }, data: { contentVersion,
            productionStructure: v2.storedStructure(stages) } });
    }
    const oldItems = current?.items || [];
    const retained = new Set(stages.flatMap((stage) => stage.meals.flatMap((meal) => meal.items.map((entry) => entry.id))).filter(Boolean));
    await tx.protocolItem.deleteMany({
        where: {
            protocolId,
            id: { in: oldItems.filter((entry) => !retained.has(entry.id)).map((entry) => entry.id) },
        },
    });
    // Reserve order keys below the existing minimum, including imported negative keys.
    const floor = Math.min(0, ...oldItems.map((entry) => entry.sequenceOrder));
    const kept = oldItems.filter((entry) => retained.has(entry.id));
    if (floor - kept.length < -2147483648) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    for (const [index, entry] of kept.entries()) {
        await tx.protocolItem.update({
            where: { id: entry.id },
            data: { sequenceOrder: floor - index - 1 },
        });
    }
    let sequenceOrder = 0;
    for (const stage of stages) {
        for (const meal of stage.meals) {
            for (const entry of meal.items) {
                const { id, dailyDoseIncrement, _materialSnapshot, ...fields } = entry;
                for (const field of ['firstDayOffset', 'lastDayOffset', 'recurrenceAnchorOffset', 'doseAnchorOffset']) delete fields[field];
                const window = contentVersion === 2 ? v2.itemWindow(entry, stage) : null;
                if (fields.recommendedProductDetails === null) fields.recommendedProductDetails = Prisma.DbNull;
                const data = {
                    ...fields,
                    startDayOffset: (window?.first ?? stage.startDayOffset) + 1,
                    endDayOffset: (window?.last ?? stage.endDayOffset) + 1,
                    mealNumber: meal.mealNumber,
                    plannedTime: plannedTime(meal.plannedTime),
                    sequenceOrder: ++sequenceOrder,
                    updatedAt: new Date(),
                    ...(contentVersion === 2 && { productionMealId: meal.id, dailyDoseIncrement: dailyDoseIncrement ?? '0',
                        recurrenceAnchorDay: window.recurrence + 1, doseAnchorDay: window.doseAnchor + 1,
                        materialSnapshot: _materialSnapshot ?? Prisma.DbNull }),
                };
                if (id) {
                    await tx.protocolItem.update({
                        where: { id },
                        data,
                    });
                } else {
                    await tx.protocolItem.create({
                        data: {
                            protocolId,
                            ...data,
                        },
                    });
                }
            }
        }
    }
};
const templateWhere = (season) => ({
    farmId: season.pond.farm.id,
    // Only active templates are eligible for new selections; existing snapshots remain independent.
    status: TemplateStatus.active,
    OR: [{ shrimpType: null }, { shrimpType: season.shrimpType }],
});

/** Scope and snapshot the selected version; rollout gates prevent unsupported clients from importing it. */
const requireTemplate = async (tx, season, templateId) => {
    const template = await tx.productionProtocolTemplate.findFirst({
        where: {
            id: templateId,
            ...templateWhere(season),
        },
        include: { items: { orderBy: { sequenceOrder: 'asc' } } },
    });
    if (!template) {
        throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.TEMPLATE_NOT_FOUND);
    }
    if (!v2.templateApplyEnabled()) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_V2_APPLICATION_UNAVAILABLE);
    await assertV2Ready(tx);
    // Prisma Date keeps milliseconds only; reject imported microsecond times instead of rounding them.
    const precise = await tx.$queryRaw`SELECT id FROM production_protocol_template_items
        WHERE template_id=${templateId}::uuid
        AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric,1000)<>0 LIMIT 1`;
    if (precise.length) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TIME_PRECISION);
    return template;
};

/** List eligible template headers without loading their item graphs. */
const templates = (accountId, seasonId, {
    search = '', page = 1, limit = 50,
} = {}) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const where = {
        ...templateWhere(season),
        ...(search && {
            title: {
                contains: search,
                mode: 'insensitive',
            },
        }),
    };
    const [totalResults, rows] = await Promise.all([
        tx.productionProtocolTemplate.count({ where }),
        tx.productionProtocolTemplate.findMany({
            where,
            orderBy: [{ title: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                title: true,
                shrimpType: true,
                allowedVariancePct: true,
                versionNo: true,
            },
        }),
    ]);
    const precise = v2.templateApplyEnabled() && rows.length ? await tx.$queryRaw`
        SELECT DISTINCT template_id AS id FROM production_protocol_template_items
        WHERE template_id IN (${Prisma.join(rows.map(row => Prisma.sql`${row.id}::uuid`))})
        AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric,1000)<>0` : [];
    const unsupported = new Set(precise.map(row => row.id));
    return {
        data: rows.map((row) => ({
            ...row,
            canApply: v2.templateApplyEnabled() && !unsupported.has(row.id),
            applicationMessage: unsupported.has(row.id) ? messages.PRODUCTION_PROTOCOL.TIME_PRECISION : null,
            allowedVariancePct: String(row.allowedVariancePct),
        })),
        meta: {
            page,
            limit,
            totalResults,
            applicationMessage: v2.templateApplyEnabled() ? null : messages.PRODUCTION_PROTOCOL.TEMPLATE_V2_APPLICATION_UNAVAILABLE,
        },
    };
});

/** Return an editable copy; never mutate the template or scale prescriptions by post count. */
const templateDetail = (accountId, seasonId, templateId) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    const template = await requireTemplate(tx, season, templateId);
    const items = template.items;
    return { title: template.title, summary: template.description, contentVersion: 2,
        allowedVariancePct: String(template.allowedVariancePct), rollingWindowDays: 7,
        templateVersionNo: template.versionNo, referencePostCount: template.referencePostCount,
        stages: v2.templateGroups(items) };

});

/**
 * Revalidate saved content before transitioning to PENDING_APPROVAL in the caller's transaction.
 * Clear previous review fields, retain audit history and leave schedule generation to approval.
 */
const submitCurrent = async (tx, season, accountId, current, notifications) => {
    const fromStatus = current.status;
    if (!current.items.length || current.items.some((item) => item.plannedTime == null)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
    }
    const groups = v2.protocolGroups(current, groupItems).map((stage) => ({
        startDayOffset: stage.startDayOffset,
        endDayOffset: stage.endDayOffset,
        meals: stage.meals.map((meal) => ({
            mealNumber: meal.mealNumber,
            items: meal.items.map(copyItem),
        })),
    }));
    if (groups.some(stage => !stage.meals.length || stage.meals.some(meal => !meal.items.length))) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
    }
    // Revalidate all products as newly selected: inactive products can remain in
    // draft history, but cannot be submitted as operational recommendations.
    await validateGraph(tx, season, groups, null, current.contentVersion ?? 1);
    const result = await tx.protocol.updateMany({
        where: {
            id: current.id,
            status: fromStatus,
        },
        data: {
            status: 'PENDING_APPROVAL',
            submittedAt: new Date(),
            updatedAt: new Date(),
            reviewedAt: null,
            reviewedBy: null,
            rejectionReason: null,
        },
    });
    if (result.count !== 1) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    await appendHistory(tx, current.id, fromStatus.toLowerCase(), 'pending_approval', accountId);
    const ownerId = season.pond.farm.ownerId;
    const notification = await tx.notification.create({
        data: {
            accountId: ownerId,
            type: NOTIFICATION_TYPE.PRODUCTION_PROTOCOL_PENDING,
            title: messages.PRODUCTION_PROTOCOL.PENDING_NOTIFICATION_TITLE,
            content: messages.PRODUCTION_PROTOCOL.PENDING_NOTIFICATION_CONTENT(
                current.title, current.versionNo, season.name, season.pond.name, season.pond.farm.name,
            ),
            referenceType: 'protocol',
            referenceId: current.id,
        },
        select: { id: true },
    });
    notifications.push({ accountId: ownerId, id: notification.id });
};

/** Require an editable status, matching revision and no dependencies before standalone submission. */
const submit = (accountId, seasonId, protocolId, body) => transaction(async (tx, notifications) => {
    const season = await scope(tx, accountId, seasonId, true);
    await tx.$queryRaw`SELECT id FROM protocols WHERE id = ${protocolId}::uuid FOR UPDATE`;
    const current = await findProtocol(tx, seasonId, protocolId);
    if (!PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(current.status) || revisionOf(current) !== body.revision) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    if (await blockers(tx, current)) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DEPENDENCY);
    }
    await submitCurrent(tx, season, accountId, current, notifications);
    return wireDetail(await findProtocol(tx, seasonId, protocolId), season, false, await history(tx, protocolId));
});

/**
 * Create the next version only when no draft, rejected or pending version is in progress.
 * Link the latest version, including cancelled ones; optional submission remains atomic.
 */
const create = (accountId, seasonId, body) => transaction(async (tx, notifications) => {
    const season = await scope(tx, accountId, seasonId, true);
    if (await tx.protocol.count({
        where: {
            seasonId,
            protocolType: 'PRODUCTION',
            status: { in: PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES },
        },
    })) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.IN_PROGRESS);
    }
    const latest = await tx.protocol.findFirst({
        where: {
            seasonId,
            protocolType: 'PRODUCTION',
        },
        orderBy: { versionNo: 'desc' },
    });
    const contentVersion = body.contentVersion ?? 1;
    await validateGraph(tx, season, body.stages, null, contentVersion);
    const {
        stages, submitForApproval, templateId, templateVersionNo, ...header
    } = body;
    delete header.contentVersion;
    let template;
    if (templateId) {
        await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
        template = await requireTemplate(tx, season, templateId);
        if (contentVersion !== 2 || template.versionNo !== templateVersionNo) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
    }
    const row = await tx.protocol.create({
        data: {
            ...header,
            sourceTemplateId: templateId || null,
            seasonId,
            protocolType: 'PRODUCTION',
            status: 'DRAFT',
            versionNo: (latest?.versionNo || 0) + 1,
            supersedesProtocolId: latest?.id || null,
            createdBy: accountId,
        },
    });
    await persistGraph(tx, row.id, stages, null, contentVersion);
    if (contentVersion === 2) await tx.protocol.update({ where: { id: row.id }, data: {
        sourceTemplateVersionNo: template?.versionNo ?? null,
        sourceTemplateSnapshot: template ? JSON.parse(JSON.stringify(template)) : Prisma.DbNull,
    } });
    await appendHistory(tx, row.id, null, 'draft', accountId);
    if (submitForApproval) {
        await submitCurrent(tx, season, accountId, await findProtocol(tx, seasonId, row.id), notifications);
    }
    return wireDetail(await findProtocol(tx, seasonId, row.id), season, false, await history(tx, row.id));
});
/**
 * Share revision and dependency checks between draft edits and cancellation.
 * Cancellation preserves items; omitted PATCH fields preserve their stored values.
 */
const mutate = (accountId, seasonId, protocolId, body, cancelling) => transaction(async (tx, notifications) => {
    const season = await scope(tx, accountId, seasonId, true);
    await tx.$queryRaw`SELECT id FROM protocols WHERE id = ${protocolId}::uuid FOR UPDATE`;
    const current = await findProtocol(tx, seasonId, protocolId);
    if (!(cancelling ? current.status === 'DRAFT' : PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(current.status))) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
    }
    if (revisionOf(current) !== body.revision) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    if (await blockers(tx, current)) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DEPENDENCY);
    }
    const {
        stages, reason, submitForApproval, templateId, templateVersionNo, contentVersion, ...header
    } = body;
    delete header.revision;
    const version = contentVersion ?? current.contentVersion ?? 1;
    if (v2.isV2(current) && version !== 2) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.V2_REQUIRED);
    if (!v2.isV2(current) && version === 2 && !stages) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.V2_REQUIRED);
    if (stages && v2.isV2(current) && contentVersion !== 2) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.V2_REQUIRED);
    let template;
    if (templateId !== undefined && !cancelling) {
        // Preserve snapshot references when the source template becomes inactive.
        if (templateId && (templateId !== current.sourceTemplateId || (templateVersionNo != null
            && templateVersionNo !== current.sourceTemplateVersionNo))) {
            await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
            template = await requireTemplate(tx, season, templateId);
            if (!stages) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
            if (version !== 2 || template.versionNo !== templateVersionNo) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
        }
        header.sourceTemplateId = templateId;
    }
    if (stages) {
        // Prisma Date truncates TIME(6) to milliseconds. Do not rewrite imported
        // sub-millisecond times through the editor and silently lose precision.
        const precise = await tx.$queryRaw`SELECT id FROM protocol_items
            WHERE protocol_id = ${protocolId}::uuid
            AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric, 1000) <> 0 LIMIT 1`;
        if (precise.length) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TIME_PRECISION);
        }
        await validateGraph(tx, season, stages, current, version);
    }
    const result = await tx.protocol.updateMany({
        where: {
            id: protocolId,
            status: current.status,
        },
        data: {
            ...(cancelling ? { status: 'CANCELLED' } : header),
            updatedAt: new Date(),
        },
    });
    if (result.count !== 1) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    }
    if (cancelling) {
        await appendHistory(tx, protocolId, 'draft', 'cancelled', accountId, reason);
    } else if (stages) {
        await persistGraph(tx, protocolId, stages, current, version);
        if (version === 2 && (template || templateId === null)) await tx.protocol.update({ where: { id: protocolId }, data:
            template ? { sourceTemplateVersionNo: template.versionNo, sourceTemplateSnapshot: JSON.parse(JSON.stringify(template)) }
                : { sourceTemplateVersionNo: null, sourceTemplateSnapshot: Prisma.DbNull } });
    }
    if (!cancelling && !stages && templateId === null && v2.isV2(current)) {
        await tx.protocol.update({ where: { id: protocolId }, data: {
            sourceTemplateVersionNo: null, sourceTemplateSnapshot: Prisma.DbNull,
        } });
    }
    if (!cancelling && submitForApproval) {
        await submitCurrent(tx, season, accountId, await findProtocol(tx, seasonId, protocolId), notifications);
    }
    return wireDetail(await findProtocol(tx, seasonId, protocolId), season, false, await history(tx, protocolId));
});

module.exports = {
    getSeason,
    list,
    detail,
    catalog,
    create,
    submit,
    templates,
    templateDetail,
    update: (accountId, seasonId, protocolId, body) => mutate(accountId, seasonId, protocolId, body, false),
    cancel: (accountId, seasonId, protocolId, body) => mutate(accountId, seasonId, protocolId, body, true),
};
