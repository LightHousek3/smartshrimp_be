const limits = require('../constants/pushNotification');
const { eventId } = require('./jobNotification');
const { courseEndsAt } = require('./protocolTimeline');
const lifecycle = require('../services/protocolLifecycle.service');

const occurrenceRelations = {
    protocolItem: { include: { protocol: { include: { items: true } } } },
    season: {
        include: { pond: { select: { farm: { select: { status: true, ownerId: true } } } } },
    },
};

/** Recheck both the effective plan and the technician's current assignment before dispatch. */
const occurrenceExpiry = async (db, slot, accountId, now) => {
    if (
        !slot ||
        slot.status !== 'PLANNED' ||
        slot.season.status !== 'ACTIVE' ||
        slot.season.pond.farm.status !== 'ACTIVE' ||
        slot.protocolItem.protocol.status !== 'ACTIVE'
    )
        return null;
    if (
        !(await db.seasonPersonnelAssignment.count({
            where: {
                seasonId: slot.seasonId,
                accountId,
                role: 'TECHNICIAN',
                unassignedAt: null,
                account: { status: 'ACTIVE', managedByOwnerId: slot.season.pond.farm.ownerId },
            },
        }))
    )
        return null;
    const protocol = slot.protocolItem.protocol;
    const end = courseEndsAt({ ...protocol, season: slot.season });
    if (!end || now >= end) return null;
    if (
        protocol.protocolType === 'PRODUCTION' &&
        (await lifecycle.productionBlocked(db, slot.seasonId, now))
    )
        return null;
    const replacement = await lifecycle.nextTreatmentStart(db, slot.seasonId, protocol.id);
    return replacement && now >= replacement ? null : new Date(Math.min(end, replacement ?? end));
};

/** A push is a short-lived hint; it cannot revive a closed occurrence or an obsolete task deadline. */
const expiresAt = async (db, notification, now) => {
    let expiry = new Date(notification.createdAt.getTime() + limits.maxAgeMs);
    if (notification.readAt || now >= expiry) return null;
    if (
        ['OPERATION_DUE', 'OPERATION_OVERDUE'].includes(notification.type) &&
        notification.referenceType === 'operation_schedule'
    ) {
        const slot = await db.operationSchedule.findUnique({
            where: { id: notification.referenceId },
            include: occurrenceRelations,
        });
        const end = await occurrenceExpiry(db, slot, notification.accountId, now);
        if (!end) return null;
        expiry = new Date(Math.min(expiry, end));
        if (notification.type === 'OPERATION_DUE')
            expiry = new Date(
                Math.min(
                    expiry,
                    slot.scheduledAt.getTime() + slot.protocolItem.dueAtMinutes * 60000,
                ),
            );
    }
    if (
        notification.type === 'OPERATION_OVERDUE' &&
        notification.referenceType === 'aquaculture_season'
    ) {
        const slots = await db.operationSchedule.findMany({
            where: {
                seasonId: notification.referenceId,
                status: 'PLANNED',
                scheduledAt: { lt: notification.createdAt },
                createdAt: { lte: notification.createdAt },
                season: { status: 'ACTIVE' },
                protocolItem: { protocol: { status: 'ACTIVE' } },
            },
            include: occurrenceRelations,
        });
        let relevant = false;
        for (const slot of slots) {
            const dueAt = new Date(
                slot.scheduledAt.getTime() + slot.protocolItem.dueAtMinutes * 60000,
            );
            if (
                dueAt <= notification.createdAt &&
                (await occurrenceExpiry(db, slot, notification.accountId, now))
            ) {
                relevant = true;
                break;
            }
        }
        if (!relevant) return null;
    }
    if (['TASK_DUE_SOON', 'TASK_OVERDUE'].includes(notification.type)) {
        const task = await db.task.findUnique({
            where: { id: notification.referenceId },
            include: { farm: { select: { ownerId: true, status: true } } },
        });
        if (
            !task?.dueAt ||
            !['PENDING', 'IN_PROGRESS'].includes(task.status) ||
            task.farm.status !== 'ACTIVE'
        )
            return null;
        const expected = eventId([
            notification.accountId,
            notification.type,
            'task',
            task.id,
            task.dueAt.toISOString(),
            task.assignedTo,
        ]);
        if (
            notification.id !== expected ||
            ![task.assignedTo, task.farm.ownerId].includes(notification.accountId)
        )
            return null;
        if (notification.type === 'TASK_DUE_SOON') expiry = new Date(Math.min(expiry, task.dueAt));
        else if (now <= task.dueAt) return null;
    }
    return now < expiry ? expiry : null;
};

const retryAt = (now, attempt) =>
    new Date(now.getTime() + Math.min(3600000, 60000 * 2 ** (attempt - 1)));
const invalidToken = (code) =>
    [
        'messaging/installation-id-not-registered',
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
    ].includes(code);
const transient = (code) =>
    [
        'messaging/server-unavailable',
        'messaging/internal-error',
        'messaging/unknown-error',
        'messaging/quota-exceeded',
        'messaging/message-rate-exceeded',
        'messaging/device-message-rate-exceeded',
        'app/network-error',
        'app/network-timeout',
    ].includes(code);

module.exports = { expiresAt, retryAt, invalidToken, transient };
