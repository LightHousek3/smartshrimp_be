const service = require('../services/protocol.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { PROTOCOL_MESSAGE: M } = require('../constants/protocol');

/**
 * GET /owner/protocols
 * Pass validated filters, including the pending inbox, within the authenticated owner scope.
 */
const list = asyncHandler(async (req, res) => {
    const { data, meta } = await service.list(req.account.id, req.query);
    ResponseHandler.success(res, { message: M.FETCHED, data, meta });
});

/**
 * GET /owner/protocols/:protocolId
 * Return the owned version, decision reason and status history from one service snapshot.
 */
const detail = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        message: M.FETCHED,
        data: await service.detail(req.account.id, req.params.protocolId),
    });
});

/**
 * GET /owner/protocols/:protocolId/days/:day
 */
const day = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        message: M.FETCHED,
        data: await service.day(req.account.id, req.params.protocolId, req.params.day),
    });
});

/**
 * POST /owner/protocols/:protocolId/review
 * Only translate validated HTTP input; transactional state transitions belong to the service.
 */
const review = asyncHandler(async (req, res) => {
    const { decision, ...input } = req.body;
    const data = await service.review(
        req.account.id,
        req.params.protocolId,
        input,
        decision === 'APPROVE',
    );
    ResponseHandler.success(res, { message: M.REVIEWED, data });
});

/**
 * GET /owner/protocols/:protocolId/schedules/:scheduleId/inventory-transactions
 */
const inventory = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        message: M.FETCHED,
        data: await service.inventory(req.account.id, req.params.protocolId, req.params.scheduleId),
    });
});
module.exports = { list, detail, day, inventory, review };
