const express = require('express');
const { seasonController, waterLogController, shrimpHealthController } = require('../controllers');
const { ACCOUNT_ROLE } = require('../constants');
const { authenticate, authorize, validate } = require('../middlewares');
const { seasonValidator, waterLogValidator, shrimpHealthValidator } = require('../validators');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

router.get('/', validate(seasonValidator.getSeasons), seasonController.getSeasons);
router.post('/', validate(seasonValidator.createSeason), seasonController.createSeason);
router.post(
    '/:seasonId/personnel-assignments',
    validate(seasonValidator.assignPersonnel),
    seasonController.assignPersonnel,
);
router.post(
    '/:seasonId/personnel-assignments/:role/replace',
    validate(seasonValidator.replacePersonnel),
    seasonController.replacePersonnel,
);
router.get('/:seasonId', validate(seasonValidator.getSeason), seasonController.getSeason);
router.patch(
    '/:seasonId/activate',
    validate(seasonValidator.activateSeason),
    seasonController.activateSeason,
);
router.patch(
    '/:seasonId/cancel',
    validate(seasonValidator.cancelSeason),
    seasonController.cancelSeason,
);
router.patch('/:seasonId', validate(seasonValidator.updateSeason), seasonController.updateSeason);

// Nhật ký đo nước — chủ trại chỉ đọc (D5).
router.get('/:seasonId/water-logs/metadata', validate(waterLogValidator.getMetadata), waterLogController.getMetadataAsOwner);
router.get('/:seasonId/water-logs', validate(waterLogValidator.listWaterLogs), waterLogController.listWaterLogsAsOwner);
router.get('/:seasonId/water-logs/statistics', validate(waterLogValidator.getStatistics), waterLogController.getStatisticsAsOwner);

// Nhật ký sức khỏe tôm — chủ trại chỉ đọc
router.get('/:seasonId/shrimp-health-logs', validate(shrimpHealthValidator.listShrimpHealthLogs), shrimpHealthController.listShrimpHealthLogsAsOwner);
router.get('/:seasonId/shrimp-health-logs/statistics', validate(shrimpHealthValidator.getStatistics), shrimpHealthController.getStatisticsAsOwner);
router.get('/:seasonId/shrimp-health-logs/:logId', validate(shrimpHealthValidator.getShrimpHealthLogDetail), shrimpHealthController.getShrimpHealthLogDetailAsOwner);

module.exports = router;
