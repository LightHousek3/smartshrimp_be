const express = require('express');
const { notificationController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { notificationValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.EXPERT,
    ACCOUNT_ROLE.FARM_OWNER,
));

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
 * @route   GET /api/v1/notifications/:notificationId
 * @desc    Get an owned notification and record its first read time
 * @access  Technician, Expert, Owner
 */
router.get(
    '/:notificationId',
    validate(notificationValidator.getNotification),
    notificationController.getNotification,
);

module.exports = router;
