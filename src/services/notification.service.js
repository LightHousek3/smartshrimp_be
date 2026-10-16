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

// The warning category matches these types; the action category uses referenceId.
const WARNING_NOTIFICATION_TYPES = [
    NOTIFICATION_TYPE.WATER_THRESHOLD_EXCEEDED,
    NOTIFICATION_TYPE.SCHEDULE_GENERATION_FAILED,
    NOTIFICATION_TYPE.INVENTORY_LOW,
    NOTIFICATION_TYPE.INVENTORY_INSUFFICIENT,
];
// Expand each supported UI group into notification types for list filtering.
const NOTIFICATION_GROUP_TYPES = {
    disease: [
        NOTIFICATION_TYPE.DISEASE_CASE_CREATED,
        NOTIFICATION_TYPE.DISEASE_CASE_RESPONSE,
        NOTIFICATION_TYPE.DISEASE_CASE_WAITING_INFO,
        NOTIFICATION_TYPE.DISEASE_CASE_MONITORING,
        NOTIFICATION_TYPE.DISEASE_CASE_RESOLVED,
        NOTIFICATION_TYPE.EMERGENCY_CASE_UPDATE,
    ],
    protocol: [
        NOTIFICATION_TYPE.PRODUCTION_PROTOCOL_PENDING,
        NOTIFICATION_TYPE.PRODUCTION_PROTOCOL_REVIEWED,
        NOTIFICATION_TYPE.TREATMENT_PROTOCOL_PENDING,
        NOTIFICATION_TYPE.TREATMENT_PROTOCOL_REVIEWED,
        NOTIFICATION_TYPE.TREATMENT_PROTOCOL_ABORTED,
        NOTIFICATION_TYPE.TREATMENT_SCHEDULE_READY,
        NOTIFICATION_TYPE.TREATMENT_SCHEDULE_COMPLETED,
    ],
    season: [
        NOTIFICATION_TYPE.SEASON_ASSIGNMENT_CREATED,
        NOTIFICATION_TYPE.SEASON_ASSIGNMENT_REPLACED,
        NOTIFICATION_TYPE.SEASON_STATUS_CHANGED,
        NOTIFICATION_TYPE.HARVEST_DUE,
        NOTIFICATION_TYPE.SEASON_COMPLETED,
    ],
    system: [NOTIFICATION_TYPE.SYSTEM],
};

/**
 * List notifications owned by an account, newest first, with optional filters.
 * Supports either page offsets or an owned notification ID as the cursor.
 *
 * @param {string} accountId - Authenticated recipient account ID
 * @param {Object} [options={}] - Pagination, read status, category, group, type,
 * and inclusive creation date filters
 * @returns {Promise<Object>} Notifications and pagination metadata
 * @throws {ApiError} If the cursor does not belong to the account
 */
const getListNotification = async (accountId, {
    cursor,
    page,
    limit = 20,
    readStatus = 'all',
    category,
    group,
    type,
    createdFrom,
    createdTo,
} = {}) => {
    const where = {
        accountId,
        ...(readStatus === 'unread' && { readAt: null }),
        ...(readStatus === 'read' && { readAt: { not: null } }),
        ...(category === 'action' && { referenceId: { not: null } }),
        // Later type filters take precedence: explicit type, then group, then category.
        ...(category === 'warning' && { type: { in: WARNING_NOTIFICATION_TYPES } }),
        ...(group && { type: { in: NOTIFICATION_GROUP_TYPES[group] } }),
        ...(type && { type }),
        ...((createdFrom || createdTo) && {
            createdAt: {
                ...(createdFrom && { gte: createdFrom }),
                ...(createdTo && { lte: createdTo }),
            },
        }),
    };

    // Reject unknown cursors and cursors owned by another recipient.
    if (cursor) {
        const cursorNotification = await prisma.notification.findFirst({
            where: { id: cursor, accountId },
            select: { id: true },
        });

        if (!cursorNotification) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.NOTIFICATION.INVALID_CURSOR);
        }
    }

    // Fetch one extra row to detect the next page; count all matching notifications.
    const [rows, totalResults] = await Promise.all([
        prisma.notification.findMany({
            where: cursor ? { ...where, id: { not: cursor } } : where,
            select: NOTIFICATION_LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(page
                ? { skip: (page - 1) * limit }
                : cursor && { cursor: { id: cursor } }),
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
            ...(page && { page }),
        },
    };
};

/**
 * Persist a notification, then notify its recipient to fetch the new record.
 *
 * @param {Object} data - Prisma notification data including accountId and type
 * @returns {Promise<Object>} Created notification
 */
const createNotification = async (data) => {
    const notification = await prisma.notification.create({
        data,
        select: NOTIFICATION_SELECT,
    });
    emitNotification(data.accountId, 'notification:new', { id: notification.id });
    return notification;
};

/**
 * Fetch an owned notification and mark it read when opened for the first time.
 * Repeated reads preserve readAt and do not emit another notification:read event.
 *
 * @param {string} accountId - Authenticated recipient account ID
 * @param {string} notificationId - Notification ID to open
 * @returns {Promise<Object>} Notification with its current read timestamp
 * @throws {ApiError} If the notification is missing or belongs to another account
 */
const getNotificationById = async (accountId, notificationId) => {
    const { notification, firstRead } = await prisma.$transaction(async (transaction) => {
        // Update only unread, owned records so concurrent opens keep the first readAt.
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
    // Emit only after the transaction commits and only if the read state changed.
    if (firstRead) {
        emitNotification(accountId, 'notification:read', {
            id: notification.id,
            readAt: notification.readAt,
        });
    }
    return notification;
};

/**
 * Mark all unread notifications for an account with a shared read timestamp.
 * Emit notification:read-all only when at least one record changes.
 *
 * @param {string} accountId - Authenticated recipient account ID
 * @returns {Promise<Object>} Updated count and timestamp used for this operation
 */
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
