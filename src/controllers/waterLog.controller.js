const { waterLogService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getIdempotencyKey = (req) => {
    const value = req.headers['idempotency-key'];
    return typeof value === 'string' ? value.trim().slice(0, 128) : '';
};

// ---- KTV (ghi + đọc) -------------------------------------------------------

/**
 * POST /me/seasons/:seasonId/water-logs
 */
const createWaterLog = asyncHandler(async (req, res) => {
    const { log } = await waterLogService.createWaterLog(
        req.account.id,
        req.params.seasonId,
        req.body,
        getIdempotencyKey(req),
    );
    ResponseHandler.created(res, { message: messages.WATER_LOG.CREATED, data: log });
});

/**
 * GET /me/seasons/:seasonId/water-logs
 */
const listWaterLogs = asyncHandler(async (req, res) => {
    const { logs, meta } = await waterLogService.listWaterLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'ktv',
    );
    ResponseHandler.paginated(res, {
        message: messages.WATER_LOG.LIST_FETCHED,
        data: logs,
        meta,
    });
});

/**
 * POST /me/seasons/:seasonId/water-logs/:logId/void
 */
const voidWaterLog = asyncHandler(async (req, res) => {
    const log = await waterLogService.voidWaterLog(
        req.account.id,
        req.params.seasonId,
        req.params.logId,
        req.body.voidReason,
    );
    ResponseHandler.success(res, { message: messages.WATER_LOG.VOIDED, data: log });
});

/**
 * GET /me/seasons/:seasonId/water-logs/statistics
 */
const getStatistics = asyncHandler(async (req, res) => {
    const statistics = await waterLogService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'ktv',
    );
    ResponseHandler.success(res, {
        message: messages.WATER_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

// ---- Chuyên gia / Chủ trại (chỉ đọc — D5) -----------------------------------

/**
 * GET /expert/seasons/:seasonId/water-logs
 */
const listWaterLogsAsExpert = asyncHandler(async (req, res) => {
    const { logs, meta } = await waterLogService.listWaterLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'expert',
    );
    ResponseHandler.paginated(res, {
        message: messages.WATER_LOG.LIST_FETCHED,
        data: logs,
        meta,
    });
});

/**
 * GET /expert/seasons/:seasonId/water-logs/statistics
 */
const getStatisticsAsExpert = asyncHandler(async (req, res) => {
    const statistics = await waterLogService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'expert',
    );
    ResponseHandler.success(res, {
        message: messages.WATER_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

/**
 * GET /owner/seasons/:seasonId/water-logs
 */
const listWaterLogsAsOwner = asyncHandler(async (req, res) => {
    const { logs, meta } = await waterLogService.listWaterLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'owner',
    );
    ResponseHandler.paginated(res, {
        message: messages.WATER_LOG.LIST_FETCHED,
        data: logs,
        meta,
    });
});

/**
 * GET /owner/seasons/:seasonId/water-logs/statistics
 */
const getStatisticsAsOwner = asyncHandler(async (req, res) => {
    const statistics = await waterLogService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'owner',
    );
    ResponseHandler.success(res, {
        message: messages.WATER_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

module.exports = {
    createWaterLog,
    listWaterLogs,
    voidWaterLog,
    getStatistics,
    listWaterLogsAsExpert,
    getStatisticsAsExpert,
    listWaterLogsAsOwner,
    getStatisticsAsOwner,
};
