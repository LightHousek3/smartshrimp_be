const { expertSeasonService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /expert/seasons
 * Return the authenticated expert's assigned-season page and scoped farm choices.
 * Current versus historical assignment access is decided by the service.
 */
const getAssignedSeasons = asyncHandler(async (req, res) => {
    const { seasons, meta } = await expertSeasonService.getAssignedSeasons(
        req.account.id,
        req.query,
    );
    ResponseHandler.paginated(res, {
        message: messages.EXPERT_SEASON.LIST_FETCHED,
        data: seasons,
        meta,
    });
});

/**
 * GET /expert/seasons/:seasonId/metrics
 * Return the assigned-season header, stocking data and professional metrics.
 */
const getAssignedSeasonMetrics = asyncHandler(async (req, res) => {
    const data = await expertSeasonService.getAssignedSeasonMetrics(req.account.id, req.params.seasonId);
    ResponseHandler.success(res, { message: messages.EXPERT_SEASON.METRICS_FETCHED, data });
});

module.exports = { getAssignedSeasons, getAssignedSeasonMetrics };
