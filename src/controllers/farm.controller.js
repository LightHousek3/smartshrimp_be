const { farmService } = require('../services');
const farmGeocodingService = require('../services/farmGeocoding.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/farms
 * Scope the complete list to the authenticated Owner for local App filtering.
 */
const getListFarm = asyncHandler(async (req, res) => {
    const farms = await farmService.getListFarm(req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.LIST_FETCHED,
        data: farms,
    });
});

/** Resolve a location without exposing the Goong REST key to mobile clients. */
const geocodeFarm = asyncHandler(async (req, res) => {
    const location = await farmGeocodingService.geocode(req.query);
    ResponseHandler.success(res, {
        message: messages.FARM.GEOCODE_FETCHED,
        data: { location },
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
 * Return the deleted farm only after all related-record checks succeed.
 */
const deleteFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.deleteFarm(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.DELETED,
        data: farm,
    });
});

module.exports = {
    geocodeFarm,
    getListFarm,
    getFarm,
    createFarm,
    updateFarm,
    deleteFarm,
};
