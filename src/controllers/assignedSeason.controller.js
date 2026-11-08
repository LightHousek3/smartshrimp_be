const { assignedSeasonService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /me/seasons
 * Return the authenticated technician’s assignment-scoped page and cursor metadata.
 */
const getAssignedSeasons = asyncHandler(async (req, res) => {
    const { seasons, meta } = await assignedSeasonService.getAssignedSeasons(req.account.id, req.query);
    ResponseHandler.paginated(res, {
        message: messages.ASSIGNED_SEASON.LIST_FETCHED,
        data: seasons,
        meta,
    });
});

/**
 * GET /me/seasons/:seasonId
 */
const getAssignedSeason = asyncHandler(async (req, res) => {
    const season = await assignedSeasonService.getAssignedSeason(req.account.id, req.params.seasonId);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.success(res, { message: messages.ASSIGNED_SEASON.FETCHED, data: season });
});

/**
 * GET /me/seasons/farms
 */
const getAssignedSeasonFarms = asyncHandler(async (req, res) => {
    const farms = await assignedSeasonService.getAssignedSeasonFarms(req.account.id);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.success(res, { message: messages.ASSIGNED_SEASON.FARMS_FETCHED, data: farms });
});

module.exports = { getAssignedSeasons, getAssignedSeason, getAssignedSeasonFarms };
