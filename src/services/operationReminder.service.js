const prisma = require('../config/prisma');
const jobTransaction = require('../utils/jobTransaction');
const logger = require('../config/logger');
const lifecycle = require('./protocolLifecycle.service');
const notices = require('../utils/jobNotification');
const { timingComparison, TIMING } = require('../utils/protocolExecution');
const { errorDetail } = require('../utils/productionSchedule');
const { PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

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
                    protocolItem: { select: { dueAtMinutes: true, materialSnapshot: true } },
                },
                orderBy: { id: 'asc' },
            });
            for (const { accountId } of personnel) {
                const previous = await tx.notification.findMany({
                    where: {
                        accountId,
                        type: { in: ['OPERATION_DUE', 'OPERATION_OVERDUE'] },
                        OR: [
                            { referenceType: 'aquaculture_season', referenceId: seasonId },
                            {
                                referenceType: 'operation_schedule',
                                referenceId: { in: schedules.map((row) => row.id) },
                            },
                        ],
                    },
                    select: { type: true, referenceType: true, referenceId: true, createdAt: true },
                });
                const reported = new Set(
                    previous
                        .filter((row) => row.referenceType === 'operation_schedule')
                        .map((row) => `${row.type}:${row.referenceId}`),
                );
                const watermark = previous
                    .filter(
                        (row) =>
                            row.type === 'OPERATION_OVERDUE' &&
                            row.referenceType === 'aquaculture_season',
                    )
                    .reduce((last, row) => Math.max(last, row.createdAt.getTime()), 0);
                const backlog = [];
                for (const schedule of schedules) {
                    const timing = timingComparison(
                        schedule,
                        schedule.protocolItem.dueAtMinutes,
                        now,
                    );
                    if (![TIMING.PENDING, TIMING.OVERDUE].includes(timing.status)) continue;
                    const type =
                        timing.status === TIMING.OVERDUE ? 'OPERATION_OVERDUE' : 'OPERATION_DUE';
                    if (reported.has(`${type}:${schedule.id}`)) continue;
                    if (
                        type === 'OPERATION_OVERDUE' &&
                        timing.dueAt.getTime() <= watermark &&
                        schedule.createdAt.getTime() <= watermark
                    )
                        continue;
                    // Persisted summary time covers only rows which already existed when it was sent.
                    if (type === 'OPERATION_OVERDUE' && timing.dueAt <= bootAt) {
                        backlog.push(schedule);
                        continue;
                    }
                    const saved = await notices.save(
                        tx,
                        [schedule.protocolItemId, schedule.scheduledAt.toISOString()],
                        {
                            accountId,
                            type,
                            referenceType: 'operation_schedule',
                            referenceId: schedule.id,
                            createdAt: now,
                            title:
                                type === 'OPERATION_DUE'
                                    ? 'Đến giờ thực hiện cữ'
                                    : 'Cữ vận hành đã quá hạn',
                            content: `${season.name}: ${schedule.protocolItem.materialSnapshot?.name ?? 'Vật tư theo phác đồ'}. ${
                                type === 'OPERATION_OVERDUE'
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
                            backlog
                                .map(
                                    (row) =>
                                        `${row.protocolItemId}:${row.scheduledAt.toISOString()}`,
                                )
                                .sort(),
                        ],
                        {
                            accountId,
                            type: 'OPERATION_OVERDUE',
                            referenceType: 'aquaculture_season',
                            referenceId: seasonId,
                            title: 'Các cữ vận hành còn quá hạn',
                            content: `${season.name}: còn ${backlog.length} cữ quá hạn chưa ghi nhận. Kiểm tra lịch trước khi thực hiện.`,
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
