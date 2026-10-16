const { notificationService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');
const { getNotificationReferenceContext } = require('../services/notificationNavigation.service');

/**
 * GET /notifications
 * Return the authenticated account's notifications using validated query filters
 * and include pagination metadata in the response.
 */
const getListNotification = asyncHandler(async (req, res) => {
    const { notifications, meta } = await notificationService.getListNotification(
        req.account.id,
        req.query,
    );

    ResponseHandler.paginated(res, {
        message: messages.NOTIFICATION.LIST_FETCHED,
        data: notifications,
        meta,
    });
});

/**
 * GET /notifications/:notificationId
 * Return an owned notification and record its first read time.
 */
const getNotification = asyncHandler(async (req, res) => {
    const notification = await notificationService.getNotificationById(
        req.account.id,
        req.params.notificationId,
    );

    // Opening a notification changes its read state; prevent a cached response.
    res.set('Cache-Control', 'no-store');
    ResponseHandler.success(res, {
        message: messages.NOTIFICATION.FETCHED,
        data: notification,
    });
});

/**
 * PATCH /notifications/read-all
 * Mark the authenticated account's unread notifications as read and return the
 * number of updated notifications together with their shared read timestamp.
 */
const markAllAsRead = asyncHandler(async (req, res) => {
    const result = await notificationService.markAllAsRead(req.account.id);

    ResponseHandler.success(res, {
        message: messages.NOTIFICATION.ALL_MARKED_READ,
        data: result,
    });
});

const getReferenceContext = asyncHandler(async (req, res) => {
    const context = await getNotificationReferenceContext(
        req.account.id, req.params.notificationId, req.account.role,
    );
    res.set('Cache-Control', 'no-store');
    ResponseHandler.success(res, { message: messages.NOTIFICATION.FETCHED, data: context });
});

module.exports = {
    getListNotification,
    getNotification,
    markAllAsRead,
    getReferenceContext,
};
