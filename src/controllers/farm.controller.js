const { farmService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getListFarm = asyncHandler(async (req, res) => {
    const farms = await farmService.getListFarm(req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.LIST_FETCHED,
        data: farms,
    });
});

const getFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.getFarmById(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.FETCHED,
        data: farm,
    });
});

const createFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.createFarm(req.body, req.account.id);

    ResponseHandler.created(res, {
        message: messages.FARM.CREATED,
        data: farm,
    });
});

const updateFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.updateFarm(req.params.farmId, req.body, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.UPDATED,
        data: farm,
    });
});

const archiveFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.archiveFarm(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.ARCHIVED,
        data: farm,
    });
});

const restoreFarm = asyncHandler(async (req, res) => {
    const farm = await farmService.restoreFarm(req.params.farmId, req.account.id);

    ResponseHandler.success(res, {
        message: messages.FARM.RESTORED,
        data: farm,
    });
});

module.exports = {
    getListFarm,
    getFarm,
    createFarm,
    updateFarm,
    archiveFarm,
    restoreFarm,
};
