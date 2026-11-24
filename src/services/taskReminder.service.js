const prisma = require('../config/prisma');
const jobTransaction = require('../utils/jobTransaction');
const logger = require('../config/logger');
const notices = require('../utils/jobNotification');
const { errorDetail } = require('../utils/productionSchedule');

/** The Owner's original assignment time remains the anchor when the deadline or task progress changes. */
const halfwayAt = (task) =>
    task.dueAt && new Date(task.createdAt.getTime() + (task.dueAt - task.createdAt) / 2);

/**
 * Lock and recheck the task before recording reminders so concurrent job runs share the same delivery
 * state.
 */
const remindTask = async (taskId, now = new Date()) => {
    const notifications = [];
    await jobTransaction(async (tx) => {
        notifications.length = 0;
        await tx.$queryRaw`SELECT id FROM tasks WHERE id=${taskId}::uuid FOR UPDATE`;
        const task = await tx.task.findFirst({
            where: {
                id: taskId,
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                dueAt: { not: null },
                farm: { status: 'ACTIVE', owner: { role: 'FARM_OWNER', status: 'ACTIVE' } },
            },
            include: {
                farm: { select: { ownerId: true } },
                assignee: { select: { role: true, status: true, managedByOwnerId: true } },
            },
        });
        if (!task) return;
        const overdue = now > task.dueAt;
        if (!overdue && now < halfwayAt(task)) return;
        const recipients = new Set(overdue ? [task.farm.ownerId] : []);
        if (
            task.assignee.role === 'TECHNICIAN' &&
            task.assignee.status === 'ACTIVE' &&
            task.assignee.managedByOwnerId === task.farm.ownerId
        )
            recipients.add(task.assignedTo);
        const type = overdue ? 'TASK_OVERDUE' : 'TASK_DUE_SOON';
        for (const accountId of recipients) {
            const key = ['task', task.id, task.dueAt.toISOString(), task.assignedTo];
            const saved = await notices.save(tx, key, {
                accountId,
                type,
                referenceType: 'task',
                referenceId: taskId,
                title: overdue
                    ? 'Công việc đã quá hạn'
                    : 'Công việc đã qua nửa thời gian được giao',
                content: `${task.title}: hạn ${task.dueAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}. ${
                    overdue
                        ? 'Cần kiểm tra tiến độ; công việc chưa tự đổi trạng thái.'
                        : 'Đã tới mốc 50% tính từ lúc giao việc, vui lòng kiểm tra tiến độ.'
                }`,
                createdAt: now,
            });
            if (saved) notifications.push(saved);
        }
    });
    notices.deliver(notifications);
};

/**
 * Sweep scheduled open tasks in bounded batches and continue after individual failures.
 */
const remind = async ({ now = new Date(), isRunning = () => true } = {}) => {
    let cursor,
        rows,
        processed = 0,
        failed = 0;
    do {
        rows = await prisma.task.findMany({
            where: {
                status: { in: ['PENDING', 'IN_PROGRESS'] },
                dueAt: { not: null },
                farm: { status: 'ACTIVE' },
                ...(cursor && { id: { gt: cursor } }),
            },
            select: { id: true },
            take: 100,
            orderBy: { id: 'asc' },
        });
        for (const row of rows) {
            if (!isRunning()) break;
            try {
                await remindTask(row.id, now);
                processed++;
            } catch (error) {
                failed++;
                logger.error(`Task ${row.id} reminder failed: ${errorDetail(error)}`);
            }
            cursor = row.id;
        }
    } while (isRunning() && rows.length === 100);
    return { processed, failed };
};

module.exports = { halfwayAt, remindTask, remind };
