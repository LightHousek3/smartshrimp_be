const { expertSeasonService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

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

module.exports = { getAssignedSeasons };
