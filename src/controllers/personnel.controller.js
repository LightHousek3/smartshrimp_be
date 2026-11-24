const { personnelService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/personnel
 */
const getListPersonnel = asyncHandler(async (req, res) => {
    const { personnel, meta } = await personnelService.getListPersonnel(req.account.id, req.query);
    ResponseHandler.paginated(res, {
        message: messages.PERSONNEL.LIST_FETCHED,
        data: personnel,
        meta,
    });
});

/**
 * GET /owner/personnel/:personnelId
 */
const getPersonnel = asyncHandler(async (req, res) => {
    const personnel = await personnelService.getPersonnelById(req.account.id, req.params.personnelId);
    ResponseHandler.success(res, {
        message: messages.PERSONNEL.FETCHED,
        data: personnel,
    });
});

module.exports = { getListPersonnel, getPersonnel };
