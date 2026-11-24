const { inventorySubstanceService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/farms/:farmId/inventory-substances
 */
const search = asyncHandler(async (req, res) => {
    const { data, meta } = await inventorySubstanceService.search(req.params.farmId, req.account.id, req.query);
    ResponseHandler.paginated(res, { data, meta, message: messages.INVENTORY_SUBSTANCE.FETCHED });
});
/**
 * POST /owner/farms/:farmId/inventory-substances/check
 */
const check = asyncHandler(async (req, res) => {
    const data = await inventorySubstanceService.check(req.params.farmId, req.account.id, req.body.ingredientsText);
    ResponseHandler.success(res, { data, message: data.message });
});
module.exports = { search, check };
