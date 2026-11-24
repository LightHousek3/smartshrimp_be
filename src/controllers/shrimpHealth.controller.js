const { shrimpHealthService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * Normalize the optional client retry key to the length accepted by the health log service.
 */
const getIdempotencyKey = (req) => {
    const value = req.headers['idempotency-key'];
    return typeof value === 'string' ? value.trim().slice(0, 128) : '';
};

/** GET /technician/seasons/:seasonId/shrimp-health-logs/population — preview the recording baseline. */
const getPopulation = asyncHandler(async (req, res) => {
    const data = await shrimpHealthService.getPopulation(req.account.id, req.params.seasonId, req.query.at);
    ResponseHandler.success(res, { message: messages.SHRIMP_HEALTH_LOG.POPULATION_FETCHED, data });
});

// ---- Technician Handlers (Read/Write) ---------------------------------------

/**
 * UC-KTV-13: Create shrimp health log
 * POST /api/v1/technician/seasons/:seasonId/shrimp-health-logs
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
 * UC-KTV-14: List shrimp health logs
 * GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs
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
 * UC-KTV-15: Get shrimp health log detail
 * GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId
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
 * UC-KTV-16: Void shrimp health log
 * PATCH /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId/void
 * (or POST /api/v1/technician/seasons/:seasonId/shrimp-health-logs/:logId/void)
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
 * UC-KTV-17: Get shrimp health and growth statistics
 * GET /api/v1/technician/seasons/:seasonId/shrimp-health-logs/statistics
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

// ---- Expert Handlers (Read Only) --------------------------------------------

/**
 * GET /expert/seasons/:seasonId/shrimp-health-logs
 */
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

/**
 * GET /expert/seasons/:seasonId/shrimp-health-logs/:logId
 */
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

/**
 * GET /expert/seasons/:seasonId/shrimp-health-logs/statistics
 */
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

// ---- Owner Handlers (Read Only) ---------------------------------------------

/**
 * GET /owner/seasons/:seasonId/shrimp-health-logs
 */
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

/**
 * GET /owner/seasons/:seasonId/shrimp-health-logs/:logId
 */
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

/**
 * GET /owner/seasons/:seasonId/shrimp-health-logs/statistics
 */
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
    getPopulation,
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
