const express = require('express');
const { notificationController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { notificationValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(
    authenticate,
    authorize(ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT, ACCOUNT_ROLE.FARM_OWNER),
);

/**
 * @route   PUT /api/v1/notifications/devices
 * @desc    Register the push endpoint for an authenticated device session
 * @access  Technician, Expert, Owner
 */
router.put(
    '/devices',
    validate(notificationValidator.registerDevice),
    notificationController.registerDevice,
);

/**
 * @route   DELETE /api/v1/notifications/devices/:deviceId
 * @desc    Remove the push endpoint owned by the authenticated account
 * @access  Technician, Expert, Owner
 */
router.delete(
    '/devices/:deviceId',
    validate(notificationValidator.unregisterDevice),
    notificationController.unregisterDevice,
);

/**
 * @route   GET /api/v1/notifications
 * @desc    List the authenticated account's notifications with filters and cursor pagination
 * @access  Technician, Expert, Owner
 */
router.get(
    '/',
    validate(notificationValidator.getListNotification),
    notificationController.getListNotification,
);

/**
 * @route   PATCH /api/v1/notifications/read-all
 * @desc    Mark all unread notifications owned by the authenticated account as read
 * @access  Technician, Expert, Owner
 */
router.patch('/read-all', notificationController.markAllAsRead);

/**
 * @route   GET /api/v1/notifications/:notificationId/reference-context
 * @desc    Resolve an owned notification's destination within the account's scope
 * @access  Technician, Expert, Owner
 */
router.get(
    '/:notificationId/reference-context',
    validate(notificationValidator.getNotification),
    notificationController.getReferenceContext,
);

/**
 * @route   GET /api/v1/notifications/:notificationId
 * @desc    Load an owned notification for the detail drawer and record its first read time
 * @access  Technician, Expert, Owner
 */
router.get(
    '/:notificationId',
    validate(notificationValidator.getNotification),
    notificationController.getNotification,
);

module.exports = router;
