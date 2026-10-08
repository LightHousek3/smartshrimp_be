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

router.post(
    '/',
    validate(waterLogValidator.createWaterLog),
    waterLogController.createWaterLog,
);
router.get(
    '/',
    validate(waterLogValidator.listWaterLogs),
    waterLogController.listWaterLogs,
);
// Đặt /statistics TRƯỚC /:logId để không bị route param nuốt.
router.get(
    '/statistics',
    validate(waterLogValidator.getStatistics),
    waterLogController.getStatistics,
);
router.post(
    '/:logId/void',
    validate(waterLogValidator.voidWaterLog),
    waterLogController.voidWaterLog,
);

module.exports = router;
