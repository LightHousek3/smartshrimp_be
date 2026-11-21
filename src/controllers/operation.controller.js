const { operationService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * UC-KTV-09: List operation schedules
 * GET /operations/seasons/:seasonId/schedules
 */
const listSchedules = asyncHandler(async (req, res) => {
    const result = await operationService.listSchedules(req.account.id, req.params.seasonId, req.query);
    ResponseHandler.success(res, {
        message: messages.OPERATION.LIST_FETCHED,
        data: result,
    });
});

/**
 * UC-KTV-10: Get operation schedule detail
 * GET /operations/schedules/:scheduleId
 */
const getSchedule = asyncHandler(async (req, res) => {
    const schedule = await operationService.getSchedule(req.account.id, req.params.scheduleId);
    ResponseHandler.success(res, {
        message: messages.OPERATION.FETCHED,
        data: schedule,
    });
});

/**
 * UC-KTV-11: Execute operation schedule
 * POST /operations/schedules/:scheduleId/execute
 */
const executeSchedule = asyncHandler(async (req, res) => {
    const execution = await operationService.executeSchedule(req.account.id, req.params.scheduleId, req.body);
    ResponseHandler.created(res, {
        message: messages.OPERATION.EXECUTED,
        data: execution,
    });
});

/**
 * UC-KTV-11b: Batch execute operation schedules (atomic transaction)
 * POST /operations/schedules/execute-batch
 */
const executeSchedulesBatch = asyncHandler(async (req, res) => {
    const executions = await operationService.executeSchedulesBatch(
        req.account.id,
        req.body.items,
    );
    ResponseHandler.created(res, {
        message: messages.OPERATION.EXECUTED,
        data: executions,
    });
});

/**
 * UC-KTV-12: Get season operation statistics
 * GET /operations/seasons/:seasonId/stats
 */
const getSeasonStats = asyncHandler(async (req, res) => {
    const stats = await operationService.getSeasonStats(req.account.id, req.params.seasonId);
    ResponseHandler.success(res, {
        message: messages.OPERATION.STATS_FETCHED,
        data: stats,
    });
});

module.exports = {
    listSchedules,
    getSchedule,
    executeSchedule,
    executeSchedulesBatch,
    getSeasonStats,
};
