const { farmService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/farms
 * Scope the list to the authenticated owner, including pond and open-season summaries.
 */
const getListFarm = asyncHandler(async (req, res) => {
    const farms = await farmService.getListFarm(req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.LIST_FETCHED,
        data: farms,
    });
});

/**
 * GET /owner/farms/:farmId
 * The service masks missing and foreign farms with the same not-found response.
 */
const getFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.getFarmById(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.FETCHED,
        data: farm,
    });
});

/**
 * POST /owner/farms
 * Attach ownership from the session rather than trusting an owner ID in the body.
 */
const createFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.createFarm(req.body, req.account.id);

    ResponseHandler.created(res, {
        message: messages.FARM.CREATED,
        data: farm,
    });
});

/**
 * PATCH /owner/farms/:farmId
 * Pass validated metadata to the owner-scoped transactional update.
 */
const updateFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.updateFarm(req.params.farmId, req.body, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.UPDATED,
        data: farm,
    });
});

/**
 * DELETE /owner/farms/:farmId
 * Return the deleted farm only after open-season and reference checks succeed.
 */
const deleteFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.deleteFarm(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.DELETED,
        data: farm,
    });
});

module.exports = {
    getListFarm,
    getFarm,
    createFarm,
    updateFarm,
    deleteFarm,
};
