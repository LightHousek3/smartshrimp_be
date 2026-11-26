const express = require('express');
const { operationController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { operationValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate);
router.use(authorize(ACCOUNT_ROLE.TECHNICIAN));

router.get('/seasons/:seasonId/stats', validate(operationValidator.getSeasonStats), operationController.getSeasonStats);
router.get('/seasons/:seasonId/schedules', validate(operationValidator.listSchedules), operationController.listSchedules);
router.post('/schedules/execute-batch', validate(operationValidator.executeSchedulesBatch), operationController.executeSchedulesBatch);
router.get('/schedules/:scheduleId', validate(operationValidator.getSchedule), operationController.getSchedule);
router.post('/schedules/:scheduleId/execute', validate(operationValidator.executeSchedule), operationController.executeSchedule);

module.exports = router;
