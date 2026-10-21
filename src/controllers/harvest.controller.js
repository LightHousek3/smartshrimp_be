/**
 * Adapt authenticated harvest requests to service calls and the shared response envelope.
 * Business rules and ownership checks are enforced by the service.
 */
const { harvestService: service } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');
const M = messages.HARVEST;

/**
 * GET /owner/seasons/:seasonId/harvests
 */
const list = asyncHandler(async (req, res) => {
    const { items, meta } = await service.list(req.account.id, req.params.seasonId, req.query);
    return ResponseHandler.paginated(res, { message: M.LIST, data: items, meta });
});
/**
 * GET /owner/seasons/:seasonId/harvests/:harvestId
 */
const detail = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: M.DETAIL,
    data: await service.detail(req.account.id, req.params.seasonId, req.params.harvestId),
}));

/**
 * POST /owner/seasons/:seasonId/harvests
 */
const create = asyncHandler(async (req, res) => {
    const result = await service.create(req.account.id, req.params.seasonId, req.body, req.idempotencyKey);
    // A replay returns the saved event without reporting a second resource creation.
    return ResponseHandler.success(res, { statusCode: result.replayed ? 200 : 201,
        message: M.CREATED, data: result.event });
});
module.exports = { list, detail, create };
