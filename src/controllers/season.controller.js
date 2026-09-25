const { seasonService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getSeasons = asyncHandler(async (req, res) => {
    const { seasons, meta } = await seasonService.getSeasons(req.account.id, req.query);
    ResponseHandler.paginated(res, {
        message: messages.SEASON.LIST_FETCHED,
        data: seasons,
        meta,
    });
});

const getSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.getSeason(req.params.seasonId, req.account.id);
    ResponseHandler.success(res, { message: messages.SEASON.FETCHED, data: season });
});

const createSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.createSeason(req.body, req.account.id);
    ResponseHandler.created(res, { message: messages.SEASON.CREATED, data: season });
});

const updateSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.updateSeason(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.SEASON.UPDATED, data: season });
});

const activateSeason = asyncHandler(async (req, res) => {
    const season = await seasonService.activateSeason(
        req.params.seasonId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.SEASON.ACTIVATED, data: season });
});

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
    updateSeason,
    activateSeason,
    cancelSeason,
};
