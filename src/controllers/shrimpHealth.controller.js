const { shrimpHealthService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getIdempotencyKey = (req) => {
    const value = req.headers['idempotency-key'];
    return typeof value === 'string' ? value.trim().slice(0, 128) : '';
};

// ---- KTV Handlers (Ghi + Đọc) -----------------------------------------------

/**
 * POST /api/v1/me/seasons/:seasonId/shrimp-health-logs
 */
const createShrimpHealthLog = asyncHandler(async (req, res) => {
    const { log } = await shrimpHealthService.createShrimpHealthLog(
        req.account.id,
        req.params.seasonId,
        req.body,
        getIdempotencyKey(req),
    );
    ResponseHandler.created(res, {
        message: messages.SHRIMP_HEALTH_LOG.CREATED,
        data: log,
    });
});

/**
 * GET /api/v1/me/seasons/:seasonId/shrimp-health-logs
 */
const listShrimpHealthLogs = asyncHandler(async (req, res) => {
    const result = await shrimpHealthService.listShrimpHealthLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'ktv',
    );
    ResponseHandler.paginated(res, {
        message: messages.SHRIMP_HEALTH_LOG.LIST_FETCHED,
        data: result.logs,
        meta: {
            nextCursor: result.nextCursor,
            hasNext: result.hasNext,
            ...(result.counts ? { counts: result.counts } : {}),
        },
    });
});

/**
 * GET /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId
 */
const getShrimpHealthLogDetail = asyncHandler(async (req, res) => {
    const log = await shrimpHealthService.getShrimpHealthLogDetail(
        req.account.id,
        req.params.seasonId,
        req.params.logId,
        'ktv',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.DETAIL_FETCHED,
        data: log,
    });
});

/**
 * PATCH /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId/void
 * (hoặc POST /api/v1/me/seasons/:seasonId/shrimp-health-logs/:logId/void)
 */
const voidShrimpHealthLog = asyncHandler(async (req, res) => {
    const log = await shrimpHealthService.voidShrimpHealthLog(
        req.account.id,
        req.params.seasonId,
        req.params.logId,
        req.body,
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.VOIDED,
        data: log,
    });
});

/**
 * GET /api/v1/me/seasons/:seasonId/shrimp-health-logs/statistics
 */
const getStatistics = asyncHandler(async (req, res) => {
    const statistics = await shrimpHealthService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'ktv',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

// ---- Expert Handlers (Chỉ đọc) ---------------------------------------------

const listShrimpHealthLogsAsExpert = asyncHandler(async (req, res) => {
    const result = await shrimpHealthService.listShrimpHealthLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'expert',
    );
    ResponseHandler.paginated(res, {
        message: messages.SHRIMP_HEALTH_LOG.LIST_FETCHED,
        data: result.logs,
        meta: {
            nextCursor: result.nextCursor,
            hasNext: result.hasNext,
            ...(result.counts ? { counts: result.counts } : {}),
        },
    });
});

const getShrimpHealthLogDetailAsExpert = asyncHandler(async (req, res) => {
    const log = await shrimpHealthService.getShrimpHealthLogDetail(
        req.account.id,
        req.params.seasonId,
        req.params.logId,
        'expert',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.DETAIL_FETCHED,
        data: log,
    });
});

const getStatisticsAsExpert = asyncHandler(async (req, res) => {
    const statistics = await shrimpHealthService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'expert',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

// ---- Owner Handlers (Chỉ đọc) ----------------------------------------------

const listShrimpHealthLogsAsOwner = asyncHandler(async (req, res) => {
    const result = await shrimpHealthService.listShrimpHealthLogs(
        req.account.id,
        req.params.seasonId,
        req.query,
        'owner',
    );
    ResponseHandler.paginated(res, {
        message: messages.SHRIMP_HEALTH_LOG.LIST_FETCHED,
        data: result.logs,
        meta: {
            nextCursor: result.nextCursor,
            hasNext: result.hasNext,
            ...(result.counts ? { counts: result.counts } : {}),
        },
    });
});

const getShrimpHealthLogDetailAsOwner = asyncHandler(async (req, res) => {
    const log = await shrimpHealthService.getShrimpHealthLogDetail(
        req.account.id,
        req.params.seasonId,
        req.params.logId,
        'owner',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.DETAIL_FETCHED,
        data: log,
    });
});

const getStatisticsAsOwner = asyncHandler(async (req, res) => {
    const statistics = await shrimpHealthService.getStatistics(
        req.account.id,
        req.params.seasonId,
        req.query,
        'owner',
    );
    ResponseHandler.success(res, {
        message: messages.SHRIMP_HEALTH_LOG.STATISTICS_FETCHED,
        data: statistics,
    });
});

module.exports = {
    createShrimpHealthLog,
    listShrimpHealthLogs,
    getShrimpHealthLogDetail,
    voidShrimpHealthLog,
    getStatistics,
    listShrimpHealthLogsAsExpert,
    getShrimpHealthLogDetailAsExpert,
    getStatisticsAsExpert,
    listShrimpHealthLogsAsOwner,
    getShrimpHealthLogDetailAsOwner,
    getStatisticsAsOwner,
};
