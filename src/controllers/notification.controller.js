const { notificationService, notificationNavigationService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');
const devices = require('../services/pushDevice.service');
const push = require('../constants/pushNotification');

/** Register the authenticated installation without exposing its endpoint token in the response. */
const registerDevice = asyncHandler(async (req, res) => {
    await devices.register(req.account.id, req.body);
    res.set('Cache-Control', 'no-store');
    ResponseHandler.success(res, { message: push.messages.REGISTERED });
});

/** Repeated logout or permission cleanup remains safe and reveals no other account's devices. */
const unregisterDevice = asyncHandler(async (req, res) => {
    await devices.unregister(req.account.id, req.params.deviceId);
    res.status(204).send();
});

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

const markAllAsRead = asyncHandler(async (req, res) => {
    const result = await notificationService.markAllAsRead(req.account.id);

    ResponseHandler.success(res, {
        message: messages.NOTIFICATION.ALL_MARKED_READ,
        data: result,
    });
});

const getReferenceContext = asyncHandler(async (req, res) => {
    const context = await notificationNavigationService.getNotificationReferenceContext(
        req.account.id,
        req.params.notificationId,
        req.account.role,
    );
    res.set('Cache-Control', 'no-store');
    ResponseHandler.success(res, { message: messages.NOTIFICATION.FETCHED, data: context });
});

module.exports = {
    registerDevice,
    unregisterDevice,
    getListNotification,
    getNotification,
    markAllAsRead,
    getReferenceContext,
};
