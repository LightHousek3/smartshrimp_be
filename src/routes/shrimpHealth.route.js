const express = require('express');
const { shrimpHealthController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { shrimpHealthValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

/**
 * Shrimp health logs — technician scope (read/write).
 * Mounted at /technician/seasons/:seasonId/shrimp-health-logs (see src/routes/index.js).
 * BR-OPS-01 / BR-HEALTH-01 are enforced in shrimpHealth.service.
 */
const router = express.Router({ mergeParams: true });

router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs/population
 * @desc    Preview the live population at the health observation time
 * @access  Assigned Technician of an ACTIVE season
 */
router.get('/population', validate(shrimpHealthValidator.getPopulation), shrimpHealthController.getPopulation);

/**
 * @route   POST /api/v1/technician/seasons/:seasonId/shrimp-health-logs
 * @desc    UC-KTV-13: Create a shrimp health log
 * @access  Technician
 */
router.post(
    '/',
    validate(shrimpHealthValidator.createShrimpHealthLog),
    shrimpHealthController.createShrimpHealthLog,
);

/**
 * @route   GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs
 * @desc    UC-KTV-14: List shrimp health logs
 * @access  Technician
 */
router.get(
    '/',
    validate(shrimpHealthValidator.listShrimpHealthLogs),
    shrimpHealthController.listShrimpHealthLogs,
);

// Declare /statistics BEFORE /:logId so it is not captured as a route parameter.
/**
 * @route   GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs/statistics
 * @desc    UC-KTV-17: Get shrimp health and growth statistics
 * @access  Technician
 */
router.get(
    '/statistics',
    validate(shrimpHealthValidator.getStatistics),
    shrimpHealthController.getStatistics,
);

/**
 * @route   GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId
 * @desc    UC-KTV-15: Get shrimp health log detail
 * @access  Technician
 */
router.get(
    '/:logId',
    validate(shrimpHealthValidator.getShrimpHealthLogDetail),
    shrimpHealthController.getShrimpHealthLogDetail,
);

/**
 * @route   PATCH /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId/void
 * @route   POST /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId/void
 * @desc    UC-KTV-16: Void a shrimp health log
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
