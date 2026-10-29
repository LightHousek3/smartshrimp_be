const {
    ProductionProtocolTemplateStatus: TemplateStatus,
} = require('@prisma/client');
const { createHash } = require('crypto');
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const { hasOverlappingStages } = require('../utils/productionProtocol');
const {
    messages,
    NOTIFICATION_TYPE,
    PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES,
    PRODUCTION_PROTOCOL_WRITABLE_SEASONS,
    allowedProductionProtocolDoseBases,
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
};
const PROTOCOL_INCLUDE = {
    items: {
        orderBy: { sequenceOrder: 'asc' },
        include: { product: { select: PRODUCT_SELECT } },
    },
};
const isWritable = (season) => PRODUCTION_PROTOCOL_WRITABLE_SEASONS.includes(season.status)
    && season.currentAssignment && season.pond.farm.status.toUpperCase() === 'ACTIVE';
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
            timeout: 15000,
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
    if (write && (!isWritable(result) || season.pond.farm.status.toUpperCase() !== 'ACTIVE')) {
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
        include: PROTOCOL_INCLUDE,
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
    const { items, ...header } = row;
    return createHash('sha256').update(JSON.stringify({
        ...header,
        items: items.map(({ product, ...fields }) => fields),
    })).digest('hex');
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
    return fields;
};
const wireDetail = (row, season, blocked, statusHistory) => ({
    id: row.id,
    seasonId: row.seasonId,
    protocolType: row.protocolType,
    versionNo: row.versionNo,
    supersedesProtocolId: row.supersedesProtocolId,
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
    stages: groupItems(row.items).map((stage) => ({
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
        pond: {
            ...data.pond,
            volumeM3: data.pond.volumeM3 == null ? null : String(data.pond.volumeM3),
            farm: {
                id: data.pond.farm.id,
                name: data.pond.farm.name,
            },
        },
        approvedProductionProtocol: approved,
        availableActions: {
            create: Boolean(currentAssignment && isWritable(season)
        && season.pond.farm.status.toUpperCase() === 'ACTIVE' && !inProgress),
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
            include: PROTOCOL_INCLUDE,
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
            stageCount: groupItems(row.items).length,
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
const validateGraph = async (tx, season, stages, current) => {
    if (hasOverlappingStages(stages)) {
        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.STAGE_OVERLAP);
    }
    const groups = groupItems(current?.items || []);
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
                if (!allowedProductionProtocolDoseBases(entry.operationType, stage.startDayOffset).includes(entry.doseBasis)) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.DOSE);
                }
                if (!entry.productId) {
                    continue;
                }
                const product = byId.get(entry.productId);
                const unchanged = oldItems.get(entry.id)?.productId === entry.productId;
                if (!product || product.farmId !== season.pond.farm.id || (!unchanged && product.status !== 'ACTIVE')) {
                    throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
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
const persistGraph = async (tx, protocolId, stages, current) => {
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
                const { id, ...fields } = entry;
                const data = {
                    ...fields,
                    startDayOffset: stage.startDayOffset + 1,
                    endDayOffset: stage.endDayOffset + 1,
                    mealNumber: meal.mealNumber,
                    plannedTime: plannedTime(meal.plannedTime),
                    sequenceOrder: ++sequenceOrder,
                    updatedAt: new Date(),
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

/** Scope the selection first, then block every entry point until applied protocols support V2 snapshots. */
const requireTemplate = async (tx, season, templateId) => {
    const template = await tx.productionProtocolTemplate.findFirst({
        where: {
            id: templateId,
            ...templateWhere(season),
        },
    });
    if (!template) {
        throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.TEMPLATE_NOT_FOUND);
    }
    throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_V2_APPLICATION_UNAVAILABLE);
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
            },
        }),
    ]);
    return {
        data: rows.map((row) => ({
            ...row,
            canApply: false,
            allowedVariancePct: String(row.allowedVariancePct),
        })),
        meta: {
            page,
            limit,
            totalResults,
            applicationMessage: messages.PRODUCTION_PROTOCOL.TEMPLATE_V2_APPLICATION_UNAVAILABLE,
        },
    };
});

/**
 * The current applied-protocol editor still uses the pre-V2 material contract.
 * Reject application until it can retain proposal evidence, manufacturer identity,
 * linear feed doses and independent recurrence anchors through Owner approval.
 */
const templateDetail = (accountId, seasonId, templateId) => transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    return requireTemplate(tx, season, templateId);
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
    const groups = groupItems(current.items).map((stage) => ({
        startDayOffset: stage.startDayOffset,
        endDayOffset: stage.endDayOffset,
        meals: stage.meals.map((meal) => ({
            items: meal.items.map(copyItem),
        })),
    }));
    // Revalidate all products as newly selected: inactive products can remain in
    // draft history, but cannot be submitted as operational recommendations.
    await validateGraph(tx, season, groups, null);
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
    await validateGraph(tx, season, body.stages, null);
    const {
        stages, submitForApproval, templateId, ...header
    } = body;
    if (templateId) {
        await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
        await requireTemplate(tx, season, templateId);
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
    await persistGraph(tx, row.id, stages, null);
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
        stages, reason, submitForApproval, templateId, ...header
    } = body;
    delete header.revision;
    if (templateId !== undefined && !cancelling) {
        // Preserve snapshot references when the source template becomes inactive.
        if (templateId && templateId !== current.sourceTemplateId) {
            await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
            await requireTemplate(tx, season, templateId);
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
        await validateGraph(tx, season, stages, current);
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
        await persistGraph(tx, protocolId, stages, current);
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
