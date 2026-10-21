const express = require('express');
const { shrimpHealthController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { shrimpHealthValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

/**
 * Nhật ký sức khỏe tôm — phạm vi KTV (ghi + đọc).
 * Mount tại /me/seasons/:seasonId/shrimp-health-logs (xem src/routes/index.js).
 * BR-OPS-01 / BR-HEALTH-01 được kiểm tra trong shrimpHealth.service.
 */
const router = express.Router({ mergeParams: true });

router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   POST /api/v1/me/seasons/:seasonId/shrimp-health-logs
 * @desc    Create a shrimp health log for an active assigned season
 * @access  Technician
 */
router.post(
    '/',
    validate(shrimpHealthValidator.createShrimpHealthLog),
    shrimpHealthController.createShrimpHealthLog,
);

/**
 * @route   GET /api/v1/me/seasons/:seasonId/shrimp-health-logs
 * @desc    List shrimp health logs for an assigned season with filters and pagination
 * @access  Technician
 */
router.get(
    '/',
    validate(shrimpHealthValidator.listShrimpHealthLogs),
    shrimpHealthController.listShrimpHealthLogs,
);

/**
 * @route   GET /api/v1/me/seasons/:seasonId/shrimp-health-logs/statistics
 * @desc    Get shrimp health and growth statistics for an assigned season
 * @access  Technician
 */
router.get(
    '/statistics',
    validate(shrimpHealthValidator.getStatistics),
    shrimpHealthController.getStatistics,
);

/**
 * @route   GET /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId
 * @desc    Get details of a shrimp health log
 * @access  Technician
 */
router.get(
    '/:logId',
    validate(shrimpHealthValidator.getShrimpHealthLogDetail),
    shrimpHealthController.getShrimpHealthLogDetail,
);

/**
 * @route   PATCH /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId/void
 * @route   POST /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId/void
 * @desc    Void a shrimp health log with a reason while the assigned season is active
 * @access  Technician
 */
router.patch(
    '/:logId/void',
    validate(shrimpHealthValidator.voidShrimpHealthLog),
    shrimpHealthController.voidShrimpHealthLog,
);
router.post(
    '/:logId/void',
    validate(shrimpHealthValidator.voidShrimpHealthLog),
    shrimpHealthController.voidShrimpHealthLog,
);

module.exports = router;
