const express = require('express');
const { expertSeasonController, waterLogController, shrimpHealthController, expertProductionProtocolController: protocolController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { expertSeasonValidator, waterLogValidator, shrimpHealthValidator, expertProductionProtocolValidator: protocolValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

// Protocol endpoints apply authentication and EXPERT authorization in the child router.
router.use('/:seasonId/production-protocols', require('./expertProductionProtocol.route'));

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/production-protocol-templates
 * @desc    List available same-farm templates matching the season's shrimp type
 * @access  Private (EXPERT with access to the season)
 */
router.get('/:seasonId/production-protocol-templates', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(protocolValidator.templates), protocolController.templates);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/production-protocol-templates/:templateId
 * @desc    Get template content for copying into a production protocol
 * @access  Private (EXPERT with access to the season)
 */
router.get('/:seasonId/production-protocol-templates/:templateId', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(protocolValidator.templateDetail), protocolController.templateDetail);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/products
 * @desc    List active same-farm products with search and pagination
 * @access  Private (EXPERT with access to the season)
 */
router.get('/:seasonId/products', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(protocolValidator.catalog), protocolController.catalog);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId
 * @desc    Get season context, approved production protocol and available actions
 * @access  Private (EXPERT with access to the season)
 */
router.get('/:seasonId', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(protocolValidator.getSeason), protocolController.getSeason);

/**
 * @route   GET /api/v1/expert/seasons
 * @desc    List assigned seasons with filters and pagination
 * @access  Private (EXPERT; includes eligible historical assignments)
 */
router.get('/', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertSeasonValidator.getAssignedSeasons),
    expertSeasonController.getAssignedSeasons);

// Water logs: experts have read-only access (D5).

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/water-logs/metadata
 * @desc    Get water-log metadata for the season
 * @access  Private (EXPERT with access to the season's water logs)
 */
router.get('/:seasonId/water-logs/metadata', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(waterLogValidator.getMetadata), waterLogController.getMetadataAsExpert);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/water-logs
 * @desc    List season water logs with filters and pagination
 * @access  Private (EXPERT with access to the season's water logs)
 */
router.get('/:seasonId/water-logs', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(waterLogValidator.listWaterLogs),
    waterLogController.listWaterLogsAsExpert);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/water-logs/statistics
 * @desc    Get water-quality statistics for the season
 * @access  Private (EXPERT with access to the season's water logs)
 */
router.get('/:seasonId/water-logs/statistics', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(waterLogValidator.getStatistics),
    waterLogController.getStatisticsAsExpert);

// Shrimp health logs: experts have read-only access.
router.get('/:seasonId/shrimp-health-logs', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(shrimpHealthValidator.listShrimpHealthLogs),
    shrimpHealthController.listShrimpHealthLogsAsExpert);

router.get('/:seasonId/shrimp-health-logs/statistics', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(shrimpHealthValidator.getStatistics),
    shrimpHealthController.getStatisticsAsExpert);

router.get('/:seasonId/shrimp-health-logs/:logId', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(shrimpHealthValidator.getShrimpHealthLogDetail),
    shrimpHealthController.getShrimpHealthLogDetailAsExpert);

module.exports = router;
