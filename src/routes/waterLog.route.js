const express = require('express');
const { waterLogController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { waterLogValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

/**
 * Nhật ký đo nước — phạm vi KTV (ghi + đọc).
 * Mount tại /me/seasons/:seasonId/water-logs (xem src/routes/index.js).
 * BR-OPS-01 / BR-WATER-01 được kiểm tra trong waterLog.service.
 */
const router = express.Router({ mergeParams: true });

router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   POST /api/v1/me/seasons/:seasonId/water-logs
 * @desc    Create a water quality log for an active assigned season and check warning thresholds
 * @access  Technician
 */
router.post(
    '/',
    validate(waterLogValidator.createWaterLog),
    waterLogController.createWaterLog,
);

/**
 * @route   GET /api/v1/me/seasons/:seasonId/water-logs
 * @desc    List water quality logs for an assigned season with filters and pagination
 * @access  Technician
 */
router.get(
    '/',
    validate(waterLogValidator.listWaterLogs),
    waterLogController.listWaterLogs,
);
// Đặt /statistics TRƯỚC /:logId để không bị route param nuốt.

/**
 * @route   GET /api/v1/me/seasons/:seasonId/water-logs/statistics
 * @desc    Get water quality statistics and threshold exceedance rates for an assigned season
 * @access  Technician
 */
router.get(
    '/statistics',
    validate(waterLogValidator.getStatistics),
    waterLogController.getStatistics,
);

/**
 * @route   POST /api/v1/me/seasons/:seasonId/water-logs/:logId/void
 * @desc    Void a water quality log with a reason while the assigned season is active
 * @access  Technician
 */
router.post(
    '/:logId/void',
    validate(waterLogValidator.voidWaterLog),
    waterLogController.voidWaterLog,
);

module.exports = router;
