const { pondService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getPonds = asyncHandler(async (req, res) => {
    const { ponds, meta } = await pondService.getPonds(
        req.params.farmId,
        req.account.id,
        req.query,
    );
    ResponseHandler.paginated(res, { message: messages.POND.LIST_FETCHED, data: ponds, meta });
});

const getPond = asyncHandler(async (req, res) => {
    const pond = await pondService.getPond(req.params.farmId, req.params.pondId, req.account.id);
    ResponseHandler.success(res, { message: messages.POND.FETCHED, data: pond });
});

const createPond = asyncHandler(async (req, res) => {
    const pond = await pondService.createPond(req.params.farmId, req.body, req.account.id);
    ResponseHandler.created(res, { message: messages.POND.CREATED, data: pond });
});

const updatePond = asyncHandler(async (req, res) => {
    const pond = await pondService.updatePond(
        req.params.farmId,
        req.params.pondId,
        req.body,
        req.account.id,
    );
    ResponseHandler.success(res, { message: messages.POND.UPDATED, data: pond });
});

const deletePond = asyncHandler(async (req, res) => {
    const pond = await pondService.deletePond(req.params.farmId, req.params.pondId, req.account.id);
    ResponseHandler.success(res, { message: messages.POND.DELETED, data: pond });
});

module.exports = { getPonds, getPond, createPond, updatePond, deletePond };
