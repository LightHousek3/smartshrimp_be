const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { NOTIFICATION_TYPE } = require('../constants');
const {
    PROTOCOL_TYPE: T,
    PROTOCOL_STATUS: S,
    PROTOCOL_MESSAGE: M,
} = require('../constants/protocol');
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
    updatedAt: true,
    reviewedBy: true,
    reviewedAt: true,
    rejectionReason: true,
    supersededAt: true,
    supersedesProtocolId: true,
    allowedVariancePct: true,
    statusHistory: {
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
        select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            changedBy: true,
            changedAt: true,
            reason: true,
        },
    },
};
const ITEM_SELECT = {
    id: true,
    operationType: true,
    productId: true,
    recommendedProductName: true,
    plannedTime: true,
    doseBasis: true,
    doseValue: true,
    doseUnit: true,
    instructions: true,
    startDayOffset: true,
    endDayOffset: true,
    repeatIntervalDays: true,
    product: { select: { name: true } },
};
const SCHEDULE_SELECT = {
    id: true,
    protocolItemId: true,
    scheduledAt: true,
    status: true,
    plannedQuantity: true,
    unit: true,
    basisQuantity: true,
    basisUnit: true,
    cancellationReason: true,
    cancelledAt: true,
    execution: {
        select: {
            actualQuantity: true,
            varianceReason: true,
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
    season: { pond: { farm: { ownerId, isDeleted: false } } },
});

/**
 * SQL DATE anchors are UTC dates, while treatment timestamps use the Vietnamese calendar.
 */
const anchorDate = (protocol) => {
    if (protocol.protocolType === T.PRODUCTION)
        return protocol.season.stockingDate?.toISOString().slice(0, 10) ?? null;
    return protocol.reviewedAt && [S.APPROVED, S.SUPERSEDED, S.ABORTED].includes(protocol.status)
        ? new Date(protocol.reviewedAt.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10)
        : null;
};
const localDate = (timestamp) =>
    new Date(timestamp.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
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
                    where: { id: seasonId, pond: { farm: { ownerId, isDeleted: false } } },
                    select: { id: true },
                }))
            )
                throw ApiError.notFound(M.SEASON_NOT_FOUND);
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
        select,
    });
    if (!protocol) throw ApiError.notFound(M.NOT_FOUND);
    return protocol;
};

/**
 * Return the protocol header and sparse day markers without loading execution payloads.
 * RepeatableRead keeps the current rejection reason, reviewer and history in one snapshot.
 */
const detail = async (ownerId, id) =>
    prisma.$transaction(
        async (client) => {
            const p = await findOwned(client, ownerId, id);
            const [refs, duration, schedules] = await Promise.all([
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
                        scheduledAt: true,
                        status: true,
                        plannedQuantity: true,
                        productId: true,
                        execution: { select: { actualQuantity: true, actualProductId: true } },
                    },
                }),
            ]);
            const anchor = anchorDate(p);
            const days = new Map();
            for (const row of schedules) {
                if (!anchor) continue;
                const day =
                    Math.round(
                        (Date.parse(localDate(row.scheduledAt)) - Date.parse(anchor)) / DAY_MS,
                    ) + 1;
                const current = days.get(day) ?? {
                    day,
                    completed: 0,
                    planned: 0,
                    cancelled: 0,
                    issues: 0,
                };
                current[row.status.toLowerCase()]++;
                const plan = Number(row.plannedQuantity);
                const execution = row.execution;
                if (
                    execution &&
                    plan > 0 &&
                    (execution.actualProductId == null ||
                        execution.actualProductId === row.productId) &&
                    Math.abs(((Number(execution.actualQuantity) - plan) / plan) * 100) >
                        Number(p.allowedVariancePct ?? 10)
                )
                    current.issues++;
                days.set(day, current);
            }
            return {
                ...card(p, refs),
                updatedAt: p.updatedAt,
                anchorDate: anchor,
                durationDays: duration._max.endDayOffset ?? 0,
                reviewedAt: p.reviewedAt,
                reviewerName: refs.accounts.get(p.reviewedBy) ?? null,
                rejectionReason: p.rejectionReason,
                supersededAt: p.supersededAt,
                dayMarkers: [...days.values()].sort((a, b) => a.day - b.day),
                history: p.statusHistory.map(({ changedBy, ...h }) => ({
                    ...h,
                    changedByName: refs.accounts.get(changedBy),
                })),
                canReview:
                    p.status === S.PENDING_APPROVAL &&
                    ['PLANNING', 'ACTIVE'].includes(p.season.status) &&
                    p.season.pond.farm.status === 'ACTIVE',
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
                season: { select: { stockingDate: true } },
            });
            const duration = await client.protocolItem.aggregate({
                where: { protocolId: id },
                _max: { endDayOffset: true },
            });
            if (selectedDay > (duration._max.endDayOffset ?? 0))
                throw ApiError.badRequest(M.INVALID_DAY);
            // Database days are one-based; calendar arithmetic is zero-based.
            const offset = selectedDay - 1;
            const anchor = anchorDate(p);
            const date = anchor
                ? new Date(Date.parse(anchor) + offset * DAY_MS).toISOString().slice(0, 10)
                : null;
            const start = date ? new Date(`${date}T00:00:00+07:00`) : null;
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
                .filter((i) => (selectedDay - i.startDayOffset) % i.repeatIntervalDays === 0)
                .flatMap((i) => {
                    const matches = schedules.filter((s) => s.protocolItemId === i.id);
                    return (matches.length ? matches : [null]).map((s) => ({
                        itemId: i.id,
                        operationType: i.operationType,
                        productName: i.product?.name ?? i.recommendedProductName ?? 'Vật tư',
                        time: s
                            ? new Date(s.scheduledAt.getTime() + VIETNAM_OFFSET_MS)
                                  .toISOString()
                                  .slice(11, 16)
                            : (i.plannedTime?.toISOString().slice(11, 16) ?? null),
                        doseBasis: i.doseBasis,
                        doseValue: Number(i.doseValue),
                        doseUnit: i.doseUnit,
                        instructions: i.instructions,
                        scheduleId: s?.id ?? null,
                        status:
                            s?.status ??
                            (p.status === S.PENDING_APPROVAL
                                ? S.PENDING_APPROVAL
                                : 'NOT_GENERATED'),
                        plannedQuantity: s ? Number(s.plannedQuantity) : null,
                        unit: s?.unit ?? i.doseUnit,
                        basisQuantity: s?.basisQuantity == null ? null : Number(s.basisQuantity),
                        basisUnit: s?.basisUnit ?? null,
                        actualQuantity: s?.execution ? Number(s.execution.actualQuantity) : null,
                        actualProductName: s?.execution?.actualProduct?.name ?? null,
                        actualUnit: s?.execution?.actualProduct?.unit ?? s?.unit ?? null,
                        varianceReason: s?.execution?.varianceReason ?? null,
                        executorName: s?.execution?.executor.fullName ?? null,
                        executedAt: s?.execution?.executedAt ?? null,
                        cancellationReason: s?.cancellationReason ?? null,
                        cancelledAt: s?.cancelledAt ?? null,
                    }));
                });
            rows.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
            return { day: selectedDay, date, rows };
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
        select: { id: true },
    });
    if (!schedule) throw ApiError.notFound(M.NOT_FOUND);
    const rows = await prisma.inventoryTransaction.findMany({
        where: {
            referenceType: 'operation_execution',
            referenceId: scheduleId,
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
            productId: true,
            product: { select: { farmId: true, status: true, isDeleted: true } },
        },
    });
    if (!items.length || items.some((i) => !i.plannedTime)) throw ApiError.forbidden(M.EMPTY);
    if (
        items.some(
            (i) =>
                i.productId &&
                (!i.product ||
                    i.product.farmId !== p.season.pond.farmId ||
                    i.product.status !== 'ACTIVE' ||
                    i.product.isDeleted),
        )
    ) {
        throw ApiError.forbidden(M.PRODUCT);
    }
    if (p.protocolType === T.TREATMENT) {
        const diseaseCase = await client.diseaseCase.findFirst({
            where: { id: p.diseaseCaseId, seasonId: p.seasonId, status: { not: 'RESOLVED' } },
            select: { id: true },
        });
        if (p.season.status !== 'ACTIVE' || !diseaseCase) throw ApiError.forbidden(M.INVALID_CASE);
    }
};

/**
 * Replace only the linked current version; completed execution facts remain immutable.
 */
const supersede = async (client, p, ownerId, now) => {
    const context = {
        seasonId: p.seasonId,
        protocolType: p.protocolType,
        diseaseCaseId: p.diseaseCaseId,
    };
    const current = await client.protocol.findFirst({
        where: { ...context, status: S.APPROVED },
        select: { id: true, versionNo: true },
    });
    if (!p.supersedesProtocolId) {
        if (current) throw ApiError.conflict(M.PREDECESSOR);
        return;
    }
    const previous = await client.protocol.findFirst({
        where: { id: p.supersedesProtocolId, ...context },
        select: { id: true, versionNo: true, status: true },
    });
    if (
        !previous ||
        previous.versionNo + 1 !== p.versionNo ||
        (current && current.id !== previous.id)
    )
        throw ApiError.conflict(M.PREDECESSOR);
    if (previous.status !== S.APPROVED) {
        if (![S.REJECTED, S.CANCELLED, S.ABORTED].includes(previous.status) || current)
            throw ApiError.conflict(M.PREDECESSOR);
        return;
    }
    const changed = await client.protocol.updateMany({
        where: { id: previous.id, status: S.APPROVED },
        data: { status: S.SUPERSEDED, supersededAt: now, updatedAt: now },
    });
    if (changed.count !== 1) throw ApiError.conflict(M.CONFLICT);
    const reason = `Chuyển sang phác đồ phiên bản ${p.versionNo}`;
    await client.protocolStatusHistory.create({
        data: {
            protocolId: previous.id,
            fromStatus: S.APPROVED,
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
 * Version replacement, decision history, case state and persisted notices roll back together.
 * Approval clears any rejection reason; socket delivery happens only after commit.
 */
const review = async (ownerId, id, { updatedAt, reason }, approved) => {
    let result;
    try {
        result = await prisma.$transaction(
            async (client) => {
                const p = await findOwned(client, ownerId, id, {
                    ...CARD_SELECT,
                    updatedAt: true,
                    supersedesProtocolId: true,
                });
                if (p.status !== S.PENDING_APPROVAL) throw ApiError.conflict(M.CONFLICT);
                if (
                    !['PLANNING', 'ACTIVE'].includes(p.season.status) ||
                    p.season.pond.farm.status !== 'ACTIVE'
                )
                    throw ApiError.forbidden(M.CLOSED);
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
                if (season.count !== 1) throw ApiError.conflict(M.CONFLICT);
                if (approved) {
                    await validateApproval(client, p);
                    await supersede(client, p, ownerId, now);
                }
                const status = approved ? S.APPROVED : S.REJECTED;
                const changed = await client.protocol.updateMany({
                    where: {
                        id,
                        status: S.PENDING_APPROVAL,
                        updatedAt: timestampWindow(updatedAt),
                    },
                    data: {
                        status,
                        reviewedBy: ownerId,
                        reviewedAt: now,
                        rejectionReason: approved ? null : reason,
                        updatedAt: now,
                    },
                });
                if (changed.count !== 1) throw ApiError.conflict(M.CONFLICT);
                await client.protocolStatusHistory.create({
                    data: {
                        protocolId: id,
                        fromStatus: S.PENDING_APPROVAL,
                        toStatus: status,
                        changedBy: ownerId,
                        changedAt: now,
                        reason: approved ? null : reason,
                    },
                });
                if (approved && p.protocolType === T.TREATMENT) {
                    await client.diseaseCase.updateMany({
                        where: {
                            id: p.diseaseCaseId,
                            seasonId: p.seasonId,
                            status: { not: 'RESOLVED' },
                        },
                        data: { status: 'IN_TREATMENT', updatedAt: now },
                    });
                }
                const notices = await notifyReview(
                    client,
                    { ...p, rejectionReason: reason },
                    approved,
                );
                return { data: { id, status, updatedAt: now }, notices };
            },
            { isolationLevel: 'Serializable' },
        );
    } catch (error) {
        if (['P2002', 'P2003', 'P2034'].includes(error.code)) throw ApiError.conflict(M.CONFLICT);
        throw error;
    }
    result.notices.forEach(({ accountId, id: notificationId }) =>
        emitNotification(accountId, 'notification:new', { id: notificationId, referenceId: id }),
    );
    return result.data;
};

module.exports = { list, detail, day, inventory, review };
