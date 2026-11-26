const prisma = require('../config/prisma');
const jobTransaction = require('../utils/jobTransaction');
const logger = require('../config/logger');
const lifecycle = require('./protocolLifecycle.service');
const notices = require('../utils/jobNotification');
const {
    operationOccurrenceKey, operationOccurrenceWhere, timingComparison, TIMING,
} = require('../utils/protocolExecution');
const { errorDetail } = require('../utils/productionSchedule');
const { PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

const occurrenceItemSelect = {
    dueAtMinutes: true, materialSnapshot: true, protocolId: true, productionMealId: true,
    mealNumber: true, protocol: { select: { protocolType: true } },
};

/** A pending sibling still belongs to the notification already sent for its meal. */
const collectOccurrences = (schedules, now) => {
    const groups = new Map();
    for (const schedule of schedules) {
        const timing = timingComparison(schedule, schedule.protocolItem.dueAtMinutes, now);
        if (![TIMING.PENDING, TIMING.OVERDUE].includes(timing.status)) continue;
        const key = operationOccurrenceKey(schedule);
        const group = groups.get(key) ?? [];
        group.push({ schedule, timing });
        groups.set(key, group);
    }
    return groups;
};

/** Serialize reminders with approval, closure, execution and assignment changes for this season. */
const remindSeason = async (seasonId, bootAt) => {
    const notifications = [];
    await jobTransaction(
        async (tx) => {
            notifications.length = 0;
            await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${seasonId}::uuid FOR UPDATE`;
            const now = new Date();
            notifications.push(...(await lifecycle.reconcile(tx, seasonId, now)));
            const season = await tx.aquacultureSeason.findUnique({
                where: { id: seasonId },
                include: { pond: { include: { farm: true } } },
            });
            if (season?.status !== 'ACTIVE' || season.pond.farm.status !== 'ACTIVE') return;
            const personnel = await tx.seasonPersonnelAssignment.findMany({
                where: {
                    seasonId,
                    role: 'TECHNICIAN',
                    unassignedAt: null,
                    account: {
                        role: 'TECHNICIAN',
                        status: 'ACTIVE',
                        managedByOwnerId: season.pond.farm.ownerId,
                    },
                },
                select: { accountId: true },
            });
            if (!personnel.length) return;
            const schedules = await tx.operationSchedule.findMany({
                where: {
                    seasonId,
                    status: 'PLANNED',
                    scheduledAt: { lte: now },
                    execution: null,
                    protocolItem: { protocol: { seasonId, status: 'ACTIVE' } },
                },
                include: {
                    protocolItem: { select: occurrenceItemSelect },
                },
                orderBy: { id: 'asc' },
            });
            const groups = collectOccurrences(schedules, now);
            if (!groups.size) return;
            const references = new Map(schedules.map((row) => [row.id, operationOccurrenceKey(row)]));
            const occurrenceFilters = [...groups.values()].map(([{ schedule }]) =>
                operationOccurrenceWhere(schedule));
            // Match the references of older notifications even when their first material is already done.
            for (let offset = 0; offset < occurrenceFilters.length; offset += 200) {
                const siblings = await tx.operationSchedule.findMany({
                    where: { seasonId, status: { not: 'PLANNED' }, OR: occurrenceFilters.slice(offset, offset + 200) },
                    select: { id: true, protocolItemId: true, scheduledAt: true,
                        protocolItem: { select: { protocolId: true, productionMealId: true, mealNumber: true } } },
                });
                for (const row of siblings) references.set(row.id, operationOccurrenceKey(row));
            }
            for (const { accountId } of personnel) {
                const previous = await tx.notification.findMany({
                    where: {
                        accountId,
                        type: { in: ['OPERATION_DUE', 'OPERATION_OVERDUE'] },
                        OR: [
                            { referenceType: 'aquaculture_season', referenceId: seasonId },
                            {
                                referenceType: 'operation_schedule',
                                referenceId: { in: [...references.keys()] },
                            },
                        ],
                    },
                    select: { type: true, referenceType: true, referenceId: true, createdAt: true },
                });
                const reported = new Set(
                    previous
                        .filter((row) => row.referenceType === 'operation_schedule')
                        .map((row) => `${row.type}:${references.get(row.referenceId)}`),
                );
                const watermark = previous
                    .filter(
                        (row) =>
                            row.type === 'OPERATION_OVERDUE' &&
                            row.referenceType === 'aquaculture_season',
                    )
                    .reduce((last, row) => Math.max(last, row.createdAt.getTime()), 0);
                const backlog = [];
                for (const [key, group] of groups) {
                    const overdue = group.filter(({ timing }) => timing.status === TIMING.OVERDUE);
                    const isOverdue = overdue.length > 0;
                    const type = isOverdue ? 'OPERATION_OVERDUE' : 'OPERATION_DUE';
                    if (reported.has(`${type}:${key}`)) continue;
                    // A backlog summary covers only rows which existed at that time.
                    const candidates = isOverdue
                        ? overdue.filter(({ schedule, timing }) =>
                            timing.dueAt.getTime() > watermark || schedule.createdAt.getTime() > watermark)
                        : group;
                    if (!candidates.length) continue;
                    if (isOverdue && candidates.every(({ timing }) => timing.dueAt <= bootAt)) {
                        backlog.push(key);
                        continue;
                    }
                    const [{ schedule }] = candidates;
                    const { protocolItem } = schedule;
                    const treatment = protocolItem.protocol.protocolType === 'TREATMENT';
                    const label = protocolItem.mealNumber != null
                        ? `Cữ ${protocolItem.mealNumber}`
                        : treatment ? 'Lượt điều trị' : 'Lượt vận hành';
                    const material = group.length > 1
                        ? `${group.length} vật tư chưa ghi nhận`
                        : protocolItem.materialSnapshot?.name ?? 'Vật tư theo phác đồ';
                    const saved = await notices.save(
                        tx,
                        ['occurrence', key],
                        {
                            accountId,
                            type,
                            referenceType: 'operation_schedule',
                            referenceId: schedule.id,
                            createdAt: now,
                            title: isOverdue ? `${label} đã quá hạn` : `Đến giờ thực hiện ${label.toLowerCase()}`,
                            content: `${season.name}: ${material}. ${
                                isOverdue
                                    ? 'Có thể ghi nhận khi phác đồ vẫn còn hiệu lực.'
                                    : 'Thực hiện theo lượng và khoảng thời gian đã lên lịch.'
                            }`,
                        },
                    );
                    if (saved) notifications.push(saved);
                }
                if (backlog.length) {
                    const saved = await notices.save(
                        tx,
                        [
                            'backlog',
                            seasonId,
                            backlog.sort(),
                        ],
                        {
                            accountId,
                            type: 'OPERATION_OVERDUE',
                            referenceType: 'aquaculture_season',
                            referenceId: seasonId,
                            title: 'Các lượt vận hành còn quá hạn',
                            content: `${season.name}: còn ${backlog.length} lượt quá hạn chưa ghi nhận. Kiểm tra lịch trước khi thực hiện.`,
                            createdAt: now,
                        },
                    );
                    if (saved) notifications.push(saved);
                }
            }
        },
        { timeout: 60000 },
    );
    notices.deliver(notifications);
};

/** Recover old overdue work by season without replaying obsolete due-now messages. */
const remind = async ({ bootAt, isRunning }) => {
    let cursor,
        rows,
        processed = 0,
        failed = 0;
    do {
        rows = await prisma.aquacultureSeason.findMany({
            where: {
                status: 'ACTIVE',
                pond: { farm: { status: 'ACTIVE' } },
                protocols: { some: { status: 'ACTIVE' } },
                ...(cursor && { id: { gt: cursor } }),
            },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: PRODUCTION_PROTOCOL_LIMITS.workerBatch,
        });
        for (const row of rows) {
            if (!isRunning()) break;
            try {
                await remindSeason(row.id, bootAt);
                processed++;
            } catch (error) {
                failed++;
                logger.error(`Season ${row.id} reminder failed: ${errorDetail(error)}`);
            }
            cursor = row.id;
        }
    } while (isRunning() && rows.length === PRODUCTION_PROTOCOL_LIMITS.workerBatch);
    return { processed, failed };
};

module.exports = { remind, remindSeason };
