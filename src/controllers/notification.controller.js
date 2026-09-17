const { notificationService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

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

const getNotification = asyncHandler(async (req, res) => {
    const notification = await notificationService.getNotificationById(
        req.account.id,
        req.params.notificationId,
    );

    res.set('Cache-Control', 'no-store');
    ResponseHandler.success(res, {
        message: messages.NOTIFICATION.FETCHED,
        data: notification,
    });
});

module.exports = {
    getListNotification,
    getNotification,
};
