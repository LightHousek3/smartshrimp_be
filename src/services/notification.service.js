const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, NOTIFICATION_TYPE } = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

const NOTIFICATION_LIST_SELECT = {
    id: true,
    title: true,
    type: true,
    referenceType: true,
    referenceId: true,
    readAt: true,
    createdAt: true,
    content: true,
};

const NOTIFICATION_SELECT = {
    ...NOTIFICATION_LIST_SELECT,
    content: true,
};

const WARNING_NOTIFICATION_TYPES = [
    NOTIFICATION_TYPE.WATER_THRESHOLD_EXCEEDED,
    NOTIFICATION_TYPE.SCHEDULE_GENERATION_FAILED,
];

const getListNotification = async (accountId, {
    cursor,
    limit = 20,
    readStatus = 'all',
    category,
    type,
    createdFrom,
    createdTo,
} = {}) => {
    const where = {
        accountId,
        ...(readStatus === 'unread' && { readAt: null }),
        ...(readStatus === 'read' && { readAt: { not: null } }),
        ...(category === 'action' && { referenceId: { not: null } }),
        ...(category === 'warning' && { type: { in: WARNING_NOTIFICATION_TYPES } }),
        ...(type && { type }),
        ...((createdFrom || createdTo) && {
            createdAt: {
                ...(createdFrom && { gte: createdFrom }),
                ...(createdTo && { lte: createdTo }),
            },
        }),
    };

    if (cursor) {
        const cursorNotification = await prisma.notification.findFirst({
            where: { id: cursor, accountId },
            select: { id: true },
        });

        if (!cursorNotification) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.NOTIFICATION.INVALID_CURSOR);
        }
    }

    const [rows, totalResults] = await Promise.all([
        prisma.notification.findMany({
            where: cursor ? { ...where, id: { not: cursor } } : where,
            select: NOTIFICATION_LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor } }),
        }),
        prisma.notification.count({ where }),
    ]);

    const hasNextPage = rows.length > limit;
    const notifications = hasNextPage ? rows.slice(0, limit) : rows;

    return {
        notifications,
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? notifications[notifications.length - 1].id : null,
        },
    };
};

const createNotification = async (data) => {
    const notification = await prisma.notification.create({
        data,
        select: NOTIFICATION_SELECT,
    });
    emitNotification(data.accountId, 'notification:new', { id: notification.id });
    return notification;
};

const getNotificationById = async (accountId, notificationId) => {
    const { notification, firstRead } = await prisma.$transaction(async (transaction) => {
        const update = await transaction.notification.updateMany({
            where: { id: notificationId, accountId, readAt: null },
            data: { readAt: new Date() },
        });

        const notification = await transaction.notification.findFirst({
            where: { id: notificationId, accountId },
            select: NOTIFICATION_SELECT,
        });

        if (!notification) {
            throw new ApiError(httpStatus.NOT_FOUND, messages.NOTIFICATION.NOT_FOUND);
        }

        return { notification, firstRead: update.count > 0 };
    });
    if (firstRead) {
        emitNotification(accountId, 'notification:read', {
            id: notification.id,
            readAt: notification.readAt,
        });
    }
    return notification;
};

const markAllAsRead = async (accountId) => {
    const readAt = new Date();
    const { count: updatedCount } = await prisma.notification.updateMany({
        where: { accountId, readAt: null },
        data: { readAt },
    });

    if (updatedCount > 0) {
        emitNotification(accountId, 'notification:read-all', {
            updatedCount,
            readAt,
        });
    }
    return { updatedCount, readAt };
};

module.exports = {
    createNotification,
    getListNotification,
    getNotificationById,
    markAllAsRead,
};
