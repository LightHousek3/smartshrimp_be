const prisma = require('../config/prisma');
const logger = require('../config/logger');
const config = require('../config');
const { ApiError, protocolStructure: structure } = require('../utils');
const productionReview = require('./productionProtocolReview.service');
const lifecycle = require('./protocolLifecycle.service');
const { assertTreatmentCourse } = require('../utils/treatmentProtocolPolicy');
const { cultureDay, occurrenceRange, scheduledAtDay } = require('../utils/protocolTimeline');
const { timingComparison, quantityComparison, TIMING } = require('../utils/protocolExecution');
const { lifecycleReason, presentProtocolHistory } = require('../utils/protocolPresentation');
const {
    PROTOCOL_TYPE: T,
    PROTOCOL_STATUS: S,
    NOTIFICATION_TYPE,
    FARM_STATUS,
    messages,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');
const { dataAccess } = require('../plugins');

const DAY_MS = 86400000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const SEASON_SELECT = {
    id: true,
    name: true,
    status: true,
    stockingDate: true,
    updatedAt: true,
    pond: {
        select: {
            id: true,
            name: true,
            farmId: true,
            farm: { select: { name: true, status: true } },
        },
    },
};
const CARD_SELECT = {
    id: true,
    seasonId: true,
    protocolType: true,
    title: true,
    summary: true,
    versionNo: true,
    status: true,
    createdBy: true,
    submittedAt: true,
    diseaseCaseId: true,
    season: { select: SEASON_SELECT },
};
const DETAIL_SELECT = {
    ...CARD_SELECT,
    season: { select: { ...SEASON_SELECT, activatedAt: true, activationDelayReason: true } },
    updatedAt: true,
    reviewedBy: true,
    reviewedAt: true,
    rejectionReason: true,
    supersededAt: true,
    supersedesProtocolId: true,
    allowedVariancePct: true,
    treatmentStartAt: true,
    statusHistory: {
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
        select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            changedBy: true,
            changedAt: true,
            reason: true,
            eventType: true,
        },
    },
};
const ITEM_SELECT = {
    id: true,
    operationType: true,
    productId: true,
    recommendedProductDetails: true,
    plannedTime: true,
    doseBasis: true,
    doseValue: true,
    doseUnit: true,
    instructions: true,
    startDayOffset: true,
    endDayOffset: true,
    repeatIntervalDays: true,
    productionMealId: true,
    dailyDoseIncrement: true,
    recurrenceAnchorDay: true,
    doseAnchorDay: true,
    materialSnapshot: true,
    dueAtMinutes: true,
    product: { select: { name: true, imageUrls: true } },
};
const SCHEDULE_SELECT = {
    id: true,
    productId: true,
    protocolItemId: true,
    scheduledAt: true,
    status: true,
    plannedQuantity: true,
    unit: true,
    basisQuantity: true,
    basisUnit: true,
    doseValueSnapshot: true,
    cancellationReason: true,
    cancelledAt: true,
    execution: {
        select: {
            actualQuantity: true,
            actualProductId: true,
            varianceReason: true,
            note: true,
            executedAt: true,
            executor: { select: { fullName: true } },
            actualProduct: { select: { name: true, unit: true } },
        },
    },
};

/**
 * Restrict every read and write to submitted versions in farms owned by this account.
 */
const ownedWhere = (ownerId) => ({
    status: { not: S.DRAFT },
    submittedAt: { not: null },
    season: { pond: { farm: { ownerId } } },
});

/**
 * SQL DATE anchors are UTC dates, while treatment timestamps use the Vietnamese calendar.
 */
const anchorDate = (protocol) => {
    if (protocol.protocolType === T.PRODUCTION)
        return protocol.season.stockingDate?.toISOString().slice(0, 10) ?? null;
    return protocol.treatmentStartAt
        ? new Date(protocol.treatmentStartAt.getTime() + VIETNAM_OFFSET_MS)
              .toISOString()
              .slice(0, 10)
        : null;
};
/**
 * Derive the Vietnam calendar date used to compare protocol schedule days.
 */
const localDate = (timestamp) =>
    new Date(timestamp.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

/** Count each occurrence once while retaining replaced cancellation rows in day history. */
const currentOccurrences = (schedules) => {
    const occurrences = new Map();
    for (const schedule of schedules) {
        const key = `${schedule.protocolItemId}:${schedule.scheduledAt.toISOString()}`;
        const previous = occurrences.get(key);
        if (
            !previous ||
            (previous.status === 'CANCELLED' &&
                (schedule.status !== 'CANCELLED' ||
                    (schedule.cancelledAt?.getTime() ?? 0) >= (previous.cancelledAt?.getTime() ?? 0)))
        ) {
            occurrences.set(key, schedule);
        }
    }
    return [...occurrences.values()];
};

/** Only the production version activated alongside the season can expose historical feed. */
const delayedActivationAt = async (client, protocol) => {
    const { activatedAt, activationDelayReason } = protocol.season;
    return protocol.protocolType === T.PRODUCTION && activatedAt && activationDelayReason &&
        await lifecycle.isActivationProduction(client, protocol.id, activatedAt)
        ? activatedAt : null;
};

const historicalScheduleTime = (protocol, item, day, activatedAt) => {
    if (!activatedAt || item.operationType !== 'FEEDING') return null;
    const at = scheduledAtDay(protocol, item, day);
    return at && at < activatedAt ? at : null;
};

const dayMarker = (markers, day) => {
    if (!markers.has(day)) markers.set(day, { day, completed: 0, planned: 0, cancelled: 0, issues: 0 });
    return markers.get(day);
};

/** Historical previews remain visible until replaced by a persisted occurrence. */
const addUnrecordedMarkers = async (client, protocol, activatedAt, occurrences, markers) => {
    const activationDay = cultureDay(protocol.season.stockingDate, activatedAt);
    if (activationDay < 1) return;
    const items = await client.protocolItem.findMany({
        where: { protocolId: protocol.id, operationType: 'FEEDING',
            startDayOffset: { lte: activationDay }, plannedTime: { not: null } },
        select: { id: true, operationType: true, plannedTime: true, startDayOffset: true,
            endDayOffset: true, repeatIntervalDays: true, recurrenceAnchorDay: true },
    });
    const persisted = new Set(occurrences.map((row) => `${row.protocolItemId}:${row.scheduledAt.getTime()}`));
    for (const item of items) {
        const range = occurrenceRange(item);
        if (!range.count) continue;
        for (let day = range.first; day <= Math.min(range.last, activationDay); day += item.repeatIntervalDays) {
            const at = historicalScheduleTime(protocol, item, day, activatedAt);
            if (!at) break;
            if (persisted.has(`${item.id}:${at.getTime()}`)) continue;
            const marker = dayMarker(markers, day);
            marker.unrecorded = (marker.unrecorded ?? 0) + 1;
        }
    }
};

const quantityAudit = (protocol, schedule) => {
    const execution = schedule?.execution;
    if (!execution || (execution.actualProductId != null && execution.actualProductId !== schedule.productId)) {
        return null;
    }
    return quantityComparison(
        schedule.plannedQuantity,
        execution.actualQuantity,
        protocol.allowedVariancePct ?? 10,
    );
};
/**
 * Match a Prisma timestamp within the millisecond precision available to the client.
 */
const timestampWindow = (date) => ({
    gte: new Date(date),
    lt: new Date(new Date(date).getTime() + 1),
});

/**
 * Fetch names and titles in batches because legacy protocol foreign keys have no Prisma relations.
 */
const references = async (client, protocols, extraAccountIds = []) => {
    const accountIds = [
        ...new Set(
            [...protocols.flatMap((p) => [p.createdBy, p.reviewedBy]), ...extraAccountIds].filter(
                Boolean,
            ),
        ),
    ];
    const caseIds = [...new Set(protocols.map((p) => p.diseaseCaseId).filter(Boolean))];
    const [accounts, cases] = await Promise.all([
        client.account.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, fullName: true },
        }),
        caseIds.length
            ? client.diseaseCase.findMany({
                  where: { id: { in: caseIds } },
                  select: { id: true, title: true },
              })
            : [],
    ]);
    return {
        accounts: new Map(accounts.map((a) => [a.id, a.fullName ?? 'Chưa có tên'])),
        cases: new Map(cases.map((c) => [c.id, c.title])),
    };
};

/**
 * Shape the card contract without exposing account records or unused protocol fields.
 */
const card = (p, refs) => ({
    id: p.id,
    seasonId: p.seasonId,
    protocolType: p.protocolType,
    title: p.title,
    summary: p.summary,
    versionNo: p.versionNo,
    status: p.status,
    authorName: refs.accounts.get(p.createdBy),
    submittedAt: p.submittedAt,
    diseaseCaseId: p.diseaseCaseId,
    diseaseCaseTitle: refs.cases.get(p.diseaseCaseId) ?? null,
    seasonName: p.season.name,
    pondName: p.season.pond.name,
    farmName: p.season.pond.farm.name,
});

/**
 * List submitted production and treatment versions or the owner's pending approval inbox.
 */
const list = async (ownerId, { seasonId, protocolType, status, page = 1, limit = 20 } = {}) =>
    prisma.$transaction(
        async (client) => {
            if (
                seasonId &&
                !(await client.aquacultureSeason.findFirst({
                    where: { id: seasonId, pond: { farm: { ownerId } } },
                    select: { id: true },
                }))
            )
                throw ApiError.notFound(messages.PROTOCOL.SEASON_NOT_FOUND);
            const base = {
                ...ownedWhere(ownerId),
                ...(seasonId && { seasonId }),
                ...(status && { status }),
            };
            const where = { ...base, ...(protocolType && { protocolType }) };
            const [{ items: rows, meta }, counts] = await Promise.all([
                dataAccess.paginateOffset({
                    delegate: client.protocol,
                    where,
                    page,
                    limit,
                    select: CARD_SELECT,
                    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
                }),
                client.protocol.groupBy({
                    by: ['protocolType'],
                    where: base,
                    _count: { _all: true },
                }),
            ]);
            const refs = await references(client, rows);
            return {
                data: rows.map((p) => card(p, refs)),
                meta: {
                    ...meta,
                    productionCount:
                        counts.find((c) => c.protocolType === T.PRODUCTION)?._count._all ?? 0,
                    treatmentCount:
                        counts.find((c) => c.protocolType === T.TREATMENT)?._count._all ?? 0,
                },
            };
        },
        { isolationLevel: 'RepeatableRead' },
    );

/**
 * Resolve an owned version; masking foreign IDs prevents cross-owner enumeration.
 */
const findOwned = async (client, ownerId, id, select = DETAIL_SELECT) => {
    const protocol = await client.protocol.findFirst({
        where: { id, ...ownedWhere(ownerId) },
        select: {
            ...select,
            sourceTemplateSnapshot: true,
            treatmentStartAt: true,
        },
    });
    if (!protocol) throw ApiError.notFound(messages.PROTOCOL.NOT_FOUND);
    return protocol;
};

/**
 * Return the protocol header and sparse day markers without loading execution payloads.
 * RepeatableRead keeps the current rejection reason, reviewer and history in one snapshot.
 */
const detail = async (ownerId, id, now = new Date()) =>
    prisma.$transaction(
        async (client) => {
            const p = await findOwned(client, ownerId, id);
            const [refs, duration, schedules, activationAt] = await Promise.all([
                references(
                    client,
                    [p],
                    p.statusHistory.map((h) => h.changedBy),
                ),
                client.protocolItem.aggregate({
                    where: { protocolId: id },
                    _max: { endDayOffset: true },
                }),
                client.operationSchedule.findMany({
                    where: { protocolItem: { protocolId: id } },
                    select: {
                        protocolItemId: true,
                        protocolItem: { select: { dueAtMinutes: true } },
                        scheduledAt: true,
                        status: true,
                        plannedQuantity: true,
                        productId: true,
                        cancelledAt: true,
                        execution: {
                            select: { actualQuantity: true, actualProductId: true, executedAt: true },
                        },
                    },
                }),
                delayedActivationAt(client, p),
            ]);
            const anchor = anchorDate(p);
            const days = new Map();
            const occurrences = currentOccurrences(schedules);
            for (const row of occurrences) {
                if (!anchor) continue;
                const day =
                    Math.round(
                        (Date.parse(localDate(row.scheduledAt)) - Date.parse(anchor)) / DAY_MS,
                    ) + 1;
                const current = dayMarker(days, day);
                current[row.status.toLowerCase()]++;
                if (
                    quantityAudit(p, row)?.exceedsThreshold ||
                    [TIMING.EARLY, TIMING.LATE].includes(
                        timingComparison(row, row.protocolItem.dueAtMinutes, now).status,
                    )
                )
                    current.issues++;
            }
            if (anchor && activationAt)
                await addUnrecordedMarkers(client, p, activationAt, occurrences, days);
            return {
                ...card(p, refs),
                farmId: p.season.pond.farmId,
                updatedAt: p.updatedAt,
                anchorDate: anchor,
                durationDays: duration._max.endDayOffset ?? 0,
                reviewedAt: p.reviewedAt,
                treatmentStartAt: p.treatmentStartAt,
                materialReviews: await productionReview.reviews(client, p, ownerId),
                scheduleMessage:
                    p.status === S.APPROVED ? messages.PRODUCTION_PROTOCOL.SCHEDULE_WAITING : null,
                reviewerName: refs.accounts.get(p.reviewedBy) ?? null,
                rejectionReason: p.rejectionReason,
                supersededAt: p.supersededAt,
                dayMarkers: [...days.values()].sort((a, b) => a.day - b.day),
                history: p.statusHistory.map((row) => {
                    const { changedBy, ...h } = presentProtocolHistory(row);
                    return {
                        ...h,
                        changedByName: changedBy
                            ? (refs.accounts.get(changedBy) ?? 'Tài khoản cũ')
                            : 'Hệ thống',
                    };
                }),
                sourceTemplateSnapshot: p.sourceTemplateSnapshot ?? null,
                canReview:
                    p.status === S.PENDING_APPROVAL &&
                    ['PLANNING', 'ACTIVE'].includes(p.season.status) &&
                    p.season.pond.farm.status === FARM_STATUS.ACTIVE,
            };
        },
        { isolationLevel: 'RepeatableRead' },
    );

/**
 * Return scheduled facts and unmaterialized rule previews for one relative day.
 */
const day = async (ownerId, id, selectedDay) =>
    prisma.$transaction(
        async (client) => {
            const p = await findOwned(client, ownerId, id, {
                id: true,
                protocolType: true,
                status: true,
                reviewedAt: true,
                allowedVariancePct: true,
                season: { select: { stockingDate: true, activatedAt: true, activationDelayReason: true } },
            });
            const duration = await client.protocolItem.aggregate({
                where: { protocolId: id },
                _max: { endDayOffset: true },
            });
            if (selectedDay > (duration._max.endDayOffset ?? 0))
                throw ApiError.badRequest(messages.PROTOCOL.INVALID_DAY);
            // Database days are one-based; calendar arithmetic is zero-based.
            const offset = selectedDay - 1;
            const anchor = anchorDate(p);
            const date = anchor
                ? new Date(Date.parse(anchor) + offset * DAY_MS).toISOString().slice(0, 10)
                : null;
            const start = date ? new Date(`${date}T00:00:00+07:00`) : null;
            const activatedAt = p.season.activatedAt;
            const activationAt = start && activatedAt && start < activatedAt
                ? await delayedActivationAt(client, p)
                : null;
            const [items, schedules] = await Promise.all([
                client.protocolItem.findMany({
                    where: {
                        protocolId: id,
                        startDayOffset: { lte: selectedDay },
                        endDayOffset: { gte: selectedDay },
                    },
                    select: ITEM_SELECT,
                    orderBy: { sequenceOrder: 'asc' },
                }),
                start
                    ? client.operationSchedule.findMany({
                          where: {
                              protocolItem: { protocolId: id },
                              scheduledAt: { gte: start, lt: new Date(start.getTime() + DAY_MS) },
                          },
                          select: SCHEDULE_SELECT,
                          orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
                      })
                    : [],
            ]);
            const rows = items
                .map((item) => {
                    structure.assertItemMetadata(item);
                    return item;
                })
                .filter((i) => structure.occursOn(i, selectedDay))
                .flatMap((i) => {
                    const matches = schedules.filter((s) => s.protocolItemId === i.id);
                    const beforeActivation = historicalScheduleTime(p, i, selectedDay, activationAt);
                    return (matches.length ? matches : [null]).map((s) => ({
                        itemId: i.id,
                        operationType: i.operationType,
                        productImageUrls: i.materialSnapshot?.imageUrls ?? i.product?.imageUrls ?? [],
                        productName:
                            i.materialSnapshot?.name ??
                            i.product?.name ??
                            i.recommendedProductDetails?.proposed?.name ??
                            'Vật tư',
                        time: s
                            ? new Date(s.scheduledAt.getTime() + VIETNAM_OFFSET_MS)
                                  .toISOString()
                                  .slice(11, 16)
                            : (i.plannedTime?.toISOString().slice(11, 16) ?? null),
                        doseBasis: i.doseBasis,
                        doseValue: Number(
                            s?.doseValueSnapshot ?? structure.doseAtDay(i, selectedDay),
                        ),
                        ...structure.itemMetadata(i),
                        doseUnit: i.doseUnit,
                        instructions: i.instructions,
                        scheduleId: s?.id ?? null,
                        productionMealId: i.productionMealId,
                        scheduledAt: s?.scheduledAt ?? null,
                        dueAt: s ? timingComparison(s, i.dueAtMinutes).dueAt : null,
                        dueAtMinutes: i.dueAtMinutes,
                        quantityExceedsThreshold: s
                            ? (quantityAudit(p, s)?.exceedsThreshold ?? null)
                            : null,
                        status:
                            s?.status ??
                            (p.status === S.PENDING_APPROVAL
                                ? S.PENDING_APPROVAL
                                : beforeActivation ? 'NOT_RECORDED' : 'NOT_GENERATED'),
                        plannedQuantity: s ? Number(s.plannedQuantity) : null,
                        unit: s?.unit ?? i.doseUnit,
                        basisQuantity: s?.basisQuantity == null ? null : Number(s.basisQuantity),
                        basisUnit: s?.basisUnit ?? null,
                        actualQuantity: s?.execution ? Number(s.execution.actualQuantity) : null,
                        actualProductName: s?.execution?.actualProduct?.name ?? null,
                        actualUnit: s?.execution
                            ? s.unit
                            : (s?.execution?.actualProduct?.unit ?? s?.unit ?? null),
                        varianceReason: s?.execution?.varianceReason ?? null,
                        note: s?.execution?.note ?? null,
                        executorName: s?.execution?.executor.fullName ?? null,
                        executedAt: s?.execution?.executedAt ?? null,
                        cancellationReason: lifecycleReason(s?.cancellationReason) ?? null,
                        cancelledAt: s?.cancelledAt ?? null,
                    }));
                });
            rows.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
            return {
                day: selectedDay,
                date,
                allowedVariancePct: Number(p.allowedVariancePct ?? 10),
                rows,
            };
        },
        { isolationLevel: 'RepeatableRead' },
    );

/**
 * Trace stock-out facts only after verifying ownership and protocol/schedule context.
 */
const inventory = async (ownerId, id, scheduleId) => {
    await findOwned(prisma, ownerId, id, { id: true });
    const schedule = await prisma.operationSchedule.findFirst({
        where: { id: scheduleId, protocolItem: { protocolId: id } },
        select: { id: true, execution: { select: { id: true } } },
    });
    if (!schedule) throw ApiError.notFound(messages.PROTOCOL.NOT_FOUND);
    if (!schedule.execution) return [];
    const rows = await prisma.inventoryTransaction.findMany({
        where: {
            referenceType: 'operation_execution',
            referenceId: schedule.execution.id,
            transactionType: 'STOCK_OUT',
        },
        select: {
            id: true,
            quantity: true,
            unitSnapshot: true,
            reason: true,
            createdAt: true,
            product: { select: { name: true } },
            inventoryBalance: { select: { lotNumber: true } },
            performer: { select: { fullName: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
        id: r.id,
        quantity: Number(r.quantity),
        unit: r.unitSnapshot,
        reason: r.reason,
        createdAt: r.createdAt,
        productName: r.product.name,
        lotNumber: r.inventoryBalance.lotNumber,
        performedByName: r.performer.fullName ?? 'Chưa có tên',
    }));
};

/**
 * Validate approval invariants without calculating stock or materializing schedules.
 */
const validateApproval = async (client, p) => {
    const items = await client.protocolItem.findMany({
        where: { protocolId: p.id },
        select: {
            plannedTime: true,
            startDayOffset: true,
            endDayOffset: true,
            repeatIntervalDays: true,
            recurrenceAnchorDay: true,
            dueAtMinutes: true,
            productId: true,
            product: { select: { farmId: true, status: true } },
        },
    });
    if (!items.length || items.some((i) => !i.plannedTime))
        throw ApiError.forbidden(messages.PROTOCOL.EMPTY);
    if (
        items.some(
            (i) =>
                i.productId &&
                (!i.product ||
                    i.product.farmId !== p.season.pond.farmId ||
                    i.product.status !== 'ACTIVE'),
        )
    ) {
        throw ApiError.forbidden(messages.PROTOCOL.PRODUCT);
    }
    if (p.protocolType === T.TREATMENT) {
        const diseaseCase = await client.diseaseCase.findFirst({
            where: { id: p.diseaseCaseId, seasonId: p.seasonId },
            select: { id: true, status: true },
        });
        if (p.season.status !== 'ACTIVE' || !diseaseCase)
            throw ApiError.forbidden(messages.PROTOCOL.INVALID_CASE);
        if (!['OPEN', 'MONITORING', 'IN_TREATMENT'].includes(diseaseCase.status))
            throw ApiError.conflict(messages.DISEASE_CASE.ALREADY_RESOLVED);
        assertTreatmentCourse({ ...p, items }, p.season, { future: true });
    }
};

/**
 * Replace only the linked current version; completed execution facts remain immutable.
 * Treatment replaces an APPROVED waiting ancestor now; an ACTIVE ancestor runs until successor activation.
 */
const supersede = async (client, p, ownerId, now) => {
    const context = {
        seasonId: p.seasonId,
        protocolType: p.protocolType,
        diseaseCaseId: p.diseaseCaseId,
    };
    const treatment = p.protocolType === T.TREATMENT;
    const replaceable = treatment ? [S.APPROVED] : [S.APPROVED, S.ACTIVE, S.PAUSED];
    const current = await client.protocol.findFirst({
        where: { ...context, status: { in: replaceable } },
        orderBy: { versionNo: 'desc' },
        select: { id: true, versionNo: true },
    });
    if (!p.supersedesProtocolId) {
        if (current) throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
        return;
    }
    let previous = await client.protocol.findFirst({
        where: { id: p.supersedesProtocolId, ...context },
        select: { id: true, versionNo: true, status: true, supersedesProtocolId: true },
    });
    if (!previous || previous.versionNo + 1 !== p.versionNo)
        throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
    // Cancelled/rejected attempts remain in the version chain but own no active plan.
    // Follow contiguous scoped links to the actual approved ancestor, never skip a broken link.
    while (!replaceable.includes(previous.status)) {
        // A running treatment remains effective until the successor's anchor.
        if (treatment && [S.ACTIVE, S.PAUSED].includes(previous.status)) {
            if (current) throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
            return;
        }
        if (
            ![S.REJECTED, S.CANCELLED, S.ABORTED, S.COMPLETED, S.SUPERSEDED].includes(
                previous.status,
            )
        )
            throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
        if (!previous.supersedesProtocolId) {
            if (previous.versionNo !== 1 || current)
                throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
            return;
        }
        const ancestor = await client.protocol.findFirst({
            where: { id: previous.supersedesProtocolId, ...context },
            select: { id: true, versionNo: true, status: true, supersedesProtocolId: true },
        });
        if (!ancestor || ancestor.versionNo + 1 !== previous.versionNo)
            throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
        previous = ancestor;
    }
    if (!current || current.id !== previous.id)
        throw ApiError.conflict(messages.PROTOCOL.PREDECESSOR);
    const changed = await client.protocol.updateMany({
        where: { id: previous.id, status: previous.status },
        data: { status: S.SUPERSEDED, supersededAt: now, updatedAt: now },
    });
    if (changed.count !== 1) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
    const reason = `Chuyển sang phác đồ phiên bản ${p.versionNo}`;
    await client.protocolStatusHistory.create({
        data: {
            protocolId: previous.id,
            fromStatus: previous.status,
            toStatus: S.SUPERSEDED,
            changedBy: ownerId,
            changedAt: now,
            reason,
        },
    });
    await client.operationSchedule.updateMany({
        where: { protocolItem: { protocolId: previous.id }, status: 'PLANNED', execution: null },
        data: {
            status: 'CANCELLED',
            cancellationType: 'PROTOCOL_SUPERSEDED',
            cancellationReason: reason,
            cancelledBy: ownerId,
            cancelledAt: now,
            updatedAt: now,
        },
    });
    return previous;
};

/**
 * Persist recipient-specific notices within the decision transaction and emit them after commit.
 */
const notifyReview = async (client, p, approved) => {
    const assignments = await client.seasonPersonnelAssignment.findMany({
        where: {
            seasonId: p.seasonId,
            unassignedAt: null,
            role: { in: approved ? ['TECHNICIAN', 'EXPERT'] : ['EXPERT'] },
        },
        select: { accountId: true },
    });
    const recipients = await client.account.findMany({
        where: {
            id: { in: [...new Set([p.createdBy, ...assignments.map((a) => a.accountId)])] },
            status: 'ACTIVE',
            role: { in: approved ? ['TECHNICIAN', 'EXPERT'] : ['EXPERT'] },
        },
        select: { id: true },
    });
    return Promise.all(
        recipients.map(async ({ id: accountId }) => {
            const notice = await client.notification.create({
                data: {
                    accountId,
                    type:
                        p.protocolType === T.PRODUCTION
                            ? NOTIFICATION_TYPE.PRODUCTION_PROTOCOL_REVIEWED
                            : NOTIFICATION_TYPE.TREATMENT_PROTOCOL_REVIEWED,
                    title: approved ? 'Phác đồ đã được phê duyệt' : 'Phác đồ bị từ chối',
                    content: `${p.title} · Phiên bản ${p.versionNo} · ${p.season.pond.name} · ${p.season.name}.${approved ? '' : ` Lý do: ${p.rejectionReason}`}`,
                    referenceType: 'protocol',
                    referenceId: p.id,
                },
                select: { id: true },
            });
            return { accountId, id: notice.id };
        }),
    );
};

/**
 * Perform the owner-only state transition with optimistic timestamp and serializable context protection.
 * Only PENDING_APPROVAL in an open season on an active farm can transition.
 * Version replacement, lifecycle reconciliation and persisted notices roll back together.
 * Treatment approval remains APPROVED; the prescribed start controls activation and IN_TREATMENT.
 * Approval clears any rejection reason; socket delivery happens only after commit.
 */
const review = async (ownerId, id, { updatedAt, reason, materialSelections = [] }, approved) => {
    let result;
    try {
        result = await prisma.$transaction(
            async (client) => {
                const p = await findOwned(client, ownerId, id, {
                    ...CARD_SELECT,
                    updatedAt: true,
                    supersedesProtocolId: true,
                    productionStructure: true,
                });
                if (p.status !== S.PENDING_APPROVAL)
                    throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
                if (
                    !['PLANNING', 'ACTIVE'].includes(p.season.status) ||
                    p.season.pond.farm.status !== FARM_STATUS.ACTIVE
                )
                    throw ApiError.forbidden(messages.PROTOCOL.CLOSED);
                const now = new Date();
                // Touch the season to serialize this decision against season state changes and concurrent decisions.
                const season = await client.aquacultureSeason.updateMany({
                    where: {
                        id: p.seasonId,
                        status: p.season.status,
                        updatedAt: timestampWindow(p.season.updatedAt),
                    },
                    data: { updatedAt: now },
                });
                if (season.count !== 1) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
                let replaced;
                const lifecycleNotices = [];
                if (approved) {
                    if (p.protocolType === T.TREATMENT) {
                        lifecycleNotices.push(
                            ...(await lifecycle.reconcile(client, p.seasonId, now)),
                        );
                    }
                    await productionReview.resolveForApproval(
                        client,
                        p,
                        ownerId,
                        materialSelections,
                    );
                    await validateApproval(client, p);
                    if (
                        p.protocolType === T.TREATMENT &&
                        (!p.treatmentStartAt || p.treatmentStartAt <= now || !p.season.stockingDate)
                    ) {
                        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.START_REQUIRED);
                    }
                    replaced = await supersede(client, p, ownerId, now);
                }
                const status = approved ? S.APPROVED : S.REJECTED;
                const decisionAt = new Date();
                if (approved && p.protocolType === T.TREATMENT && p.treatmentStartAt <= decisionAt)
                    throw ApiError.conflict(messages.TREATMENT_PROTOCOL.START_REQUIRED);
                const changed = await client.protocol.updateMany({
                    where: {
                        id,
                        status: S.PENDING_APPROVAL,
                        updatedAt: timestampWindow(updatedAt),
                    },
                    data: {
                        status,
                        reviewedBy: ownerId,
                        reviewedAt: decisionAt,
                        rejectionReason: approved ? null : reason,
                        updatedAt: decisionAt,
                    },
                });
                if (changed.count !== 1) throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
                await client.protocolStatusHistory.create({
                    data: {
                        protocolId: id,
                        fromStatus: S.PENDING_APPROVAL,
                        toStatus: status,
                        changedBy: ownerId,
                        changedAt: decisionAt,
                        reason: approved ? null : reason,
                    },
                });
                if (approved && replaced && p.protocolType === T.TREATMENT) {
                    const holds = (await lifecycle.activeHolds(client, p.seasonId)).filter(
                        (row) => row.eventData?.waitingForProtocolId === replaced.id,
                    );
                    if (holds.length) {
                        const successor = { ...p, status: S.APPROVED };
                        await lifecycle.release(
                            client,
                            successor,
                            ownerId,
                            'Chuyển giữ chăm sóc sang bản điều trị chờ mới.',
                            holds,
                            decisionAt,
                        );
                        await lifecycle.hold(
                            client,
                            successor,
                            ownerId,
                            'Giữ chăm sóc tới mốc bản điều trị chờ mới.',
                            decisionAt,
                            { waitingForProtocolId: id, replacesProtocolId: replaced.id },
                        );
                    }
                }
                if (approved)
                    lifecycleNotices.push(
                        ...(await lifecycle.reconcile(client, p.seasonId, decisionAt)),
                    );
                const notices = [
                    ...lifecycleNotices,
                    ...(await notifyReview(client, { ...p, rejectionReason: reason }, approved)),
                ];
                return {
                    data: { id, status, updatedAt: decisionAt },
                    notices,
                    seasonId: p.seasonId,
                };
            },
            {
                isolationLevel: 'Serializable',
                timeout: config.productionProtocol.transactionTimeoutMs,
            },
        );
    } catch (error) {
        if (['P2002', 'P2003', 'P2034'].includes(error.code))
            throw ApiError.conflict(messages.PROTOCOL.CONFLICT);
        throw error;
    }
    for (const { accountId, id: notificationId } of result.notices) {
        // Review is already committed; a realtime outage must not report a failed decision.
        try {
            emitNotification(accountId, 'notification:new', {
                id: notificationId,
                referenceId: id,
            });
        } catch (_) {
            logger.warn('Protocol review notification realtime delivery failed after commit.');
        }
    }
    require('../jobs').requestSeason(result.seasonId);
    return result.data;
};

/**
 * Check protocol ownership and read replacement materials from one consistent database snapshot.
 */
const materialOptions = async (ownerId, id, { itemId, search }) =>
    prisma.$transaction(
        async (client) => {
            const protocol = await findOwned(client, ownerId, id);
            return productionReview.options(client, ownerId, protocol, itemId, search);
        },
        {
            isolationLevel: 'RepeatableRead',
            timeout: config.productionProtocol.transactionTimeoutMs,
        },
    );

module.exports = { list, detail, day, inventory, review, materialOptions };
