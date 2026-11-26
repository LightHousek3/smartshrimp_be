const { ApiError, protocolStructure: structure } = require('../utils');
const { PROTOCOL_TYPE: T, PROTOCOL_STATUS: S, messages } = require('../constants');
const { historicalScheduleTime } = require('../utils/protocolTimeline');
const { quantityAudit, timingComparison } = require('../utils/protocolExecution');
const { lifecycleReason } = require('../utils/protocolPresentation');
const lifecycle = require('./protocolLifecycle.service');

const DAY_MS = 86400000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
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
    mealNumber: true,
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
    cancelledByAccount: { select: { fullName: true } },
    execution: {
        select: {
            actualQuantity: true,
            actualProductId: true,
            varianceReason: true,
            note: true,
            executedAt: true,
            createdAt: true,
            executor: { select: { fullName: true } },
            actualProduct: { select: { name: true, unit: true } },
        },
    },
};

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

/** Only the production version activated alongside the season can expose historical feed. */
const delayedActivationAt = async (client, protocol) => {
    const { activatedAt, activationDelayReason } = protocol.season;
    return protocol.protocolType === T.PRODUCTION && activatedAt && activationDelayReason &&
        await lifecycle.isActivationProduction(client, protocol.id, activatedAt)
        ? activatedAt : null;
};

/** Project one relative day for a protocol already authorized by the caller. */
const readDay = async (client, p, selectedDay) => {
    const id = p.id;
    if (!Number.isInteger(selectedDay) || selectedDay < 1)
        throw ApiError.badRequest(messages.PROTOCOL.INVALID_DAY);
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
    const schedulesByItem = new Map();
    for (const schedule of schedules) {
        if (!schedulesByItem.has(schedule.protocolItemId)) schedulesByItem.set(schedule.protocolItemId, []);
        schedulesByItem.get(schedule.protocolItemId).push(schedule);
    }
    const now = new Date();
    const rows = items
        .map((item) => {
            structure.assertItemMetadata(item);
            return item;
        })
        .filter((i) => structure.occursOn(i, selectedDay))
        .flatMap((i) => {
            const matches = schedulesByItem.get(i.id) ?? [];
            const beforeActivation = historicalScheduleTime(p, i, selectedDay, activationAt);
            return (matches.length ? matches : [null]).map((s) => {
                const timing = s ? timingComparison(s, i.dueAtMinutes, now) : null;
                const comparison = s ? quantityAudit(p, s) : null;
                return {
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
                    mealNumber: i.mealNumber,
                    scheduledAt: s?.scheduledAt ?? null,
                    dueAt: timing?.dueAt ?? null,
                    dueAtMinutes: i.dueAtMinutes,
                    quantityExceedsThreshold: comparison?.exceedsThreshold ?? null,
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
                    actualProductDiffers: s?.execution?.actualProductId != null &&
                        s.execution.actualProductId !== s.productId,
                    actualUnit: s?.execution
                        ? s.unit
                        : (s?.execution?.actualProduct?.unit ?? s?.unit ?? null),
                    varianceReason: s?.execution?.varianceReason ?? null,
                    note: s?.execution?.note ?? null,
                    executorName: s?.execution?.executor?.fullName ?? null,
                    executedAt: s?.execution?.executedAt ?? null,
                    recordedAt: s?.execution?.createdAt ?? null,
                    quantityComparison: comparison,
                    timingStatus: timing?.status ?? null,
                    cancellationReason: lifecycleReason(s?.cancellationReason) ?? null,
                    cancelledAt: s?.cancelledAt ?? null,
                    cancelledByName: s?.cancelledByAccount?.fullName ?? null,
                };
            });
        });
    rows.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    return {
        day: selectedDay,
        date,
        allowedVariancePct: Number(p.allowedVariancePct ?? 10),
        rows,
    };
};

module.exports = { readDay, anchorDate, localDate, delayedActivationAt, DAY_MS };
