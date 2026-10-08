const express = require('express');
const { expertSeasonController, waterLogController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { expertSeasonValidator, waterLogValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
router.get('/', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertSeasonValidator.getAssignedSeasons),
    expertSeasonController.getAssignedSeasons);

// Nhật ký đo nước — chuyên gia chỉ đọc (D5).
router.get('/:seasonId/water-logs', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(waterLogValidator.listWaterLogs),
    waterLogController.listWaterLogsAsExpert);
router.get('/:seasonId/water-logs/statistics', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(waterLogValidator.getStatistics),
    waterLogController.getStatisticsAsExpert);

module.exports = router;
