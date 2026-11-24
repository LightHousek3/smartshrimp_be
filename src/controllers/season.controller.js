const { seasonService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/seasons
 */
const getSeasons = asyncHandler(async (req, res) => {
    const { seasons, meta } = await seasonService.getSeasons(req.account.id, req.query);
    ResponseHandler.paginated(res, {
        message: messages.SEASON.LIST_FETCHED,
        data: seasons,
        meta,
    });
});

/**
 * GET /owner/seasons/:seasonId
 */
const getSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.getSeason(req.params.seasonId, req.account.id);
    ResponseHandler.success(res, { message: messages.SEASON.FETCHED, data: season });
});

/**
 * POST /owner/seasons
 */
const createSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.createSeason(req.body, req.account.id);
    ResponseHandler.created(res, { message: messages.SEASON.CREATED, data: season });
});

/**
 * POST /owner/seasons/:seasonId/personnel-assignments
 */
const assignPersonnel = asyncHandler(async (req, res) => {
    const assignment = await seasonService.assignPersonnel(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.created(res, {
        message: messages.SEASON.PERSONNEL_ASSIGNED,
        data: assignment,
    });
});

/**
 * POST /owner/seasons/:seasonId/personnel-assignments/:role/replace
 */
const replacePersonnel = asyncHandler(async (req, res) => {
    const result = await seasonService.replacePersonnel(
        req.params.seasonId,
        req.params.role,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, {
        message: messages.SEASON.PERSONNEL_REPLACED,
        data: result,
    });
});

/**
 * PATCH /owner/seasons/:seasonId
 */
const updateSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.updateSeason(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.SEASON.UPDATED, data: season });
});

/**
 * PATCH /owner/seasons/:seasonId/activate
 */
const activateSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.activateSeason(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.SEASON.ACTIVATED, data: season });
});

/**
 * PATCH /owner/seasons/:seasonId/cancel
 */
const cancelSeason = asyncHandler(async (req, res) => {
    const result = await seasonService.cancelSeason(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.SEASON.CANCELLED, data: result });
});

module.exports = {
    getSeasons,
    getSeason,
    createSeason,
    assignPersonnel,
    replacePersonnel,
    updateSeason,
    activateSeason,
    cancelSeason,
};
