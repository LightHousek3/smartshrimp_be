const { operationService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * UC-09: Xem danh sách kế hoạch vận hành
 */
const listSchedules = asyncHandler(async (req, res) => {
    const result = await operationService.listSchedules(req.account.id, req.params.seasonId, req.query);
    ResponseHandler.success(res, {
        message: messages.OPERATION.LIST_FETCHED,
        data: result,
    });
});

/**
 * UC-10: Xem chi tiết kế hoạch vận hành
 */
const getSchedule = asyncHandler(async (req, res) => {
    const schedule = await operationService.getSchedule(req.account.id, req.params.scheduleId);
    ResponseHandler.success(res, {
        message: messages.OPERATION.FETCHED,
        data: schedule,
    });
});

/**
 * UC-11: Ghi nhận thực hiện hoạt động
 */
const executeSchedule = asyncHandler(async (req, res) => {
    const execution = await operationService.executeSchedule(req.account.id, req.params.scheduleId, req.body);
    ResponseHandler.created(res, {
        message: messages.OPERATION.EXECUTED,
        data: execution,
    });
});

/**
 * UC-12: Xem thống kê vận hành
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
    getSeasonStats,
};
