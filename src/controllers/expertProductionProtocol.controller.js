const { expertProductionProtocolService: service } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /expert/seasons/:seasonId
 */
const getSeason = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    data: await service.getSeason(req.account.id, req.params.seasonId),
}));

/**
 * GET /expert/seasons/:seasonId/production-protocols/:protocolId
 */
const detail = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    data: await service.detail(req.account.id, req.params.seasonId, req.params.protocolId),
}));

/**
 * GET /expert/seasons/:seasonId/production-protocols
 */
const list = asyncHandler(async (req, res) => ResponseHandler.paginated(res,
    await service.list(req.account.id, req.params.seasonId, req.query)));

/**
 * GET /expert/seasons/:seasonId/products
 */
const catalog = asyncHandler(async (req, res) => ResponseHandler.paginated(res,
    await service.catalog(req.account.id, req.params.seasonId, req.query)));

/**
 * POST /expert/seasons/:seasonId/production-protocols
 * Save a draft and optionally submit it for approval in the same transaction.
 */
const create = asyncHandler(async (req, res) => ResponseHandler.created(res, {
    message: req.body.submitForApproval ? messages.PRODUCTION_PROTOCOL.SUBMITTED : messages.PRODUCTION_PROTOCOL.CREATED,
    data: await service.create(req.account.id, req.params.seasonId, req.body),
}));

/**
 * PATCH /expert/seasons/:seasonId/production-protocols/:protocolId
 * Require the current revision; only draft or rejected protocols can be edited.
 */
const update = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: req.body.submitForApproval ? messages.PRODUCTION_PROTOCOL.SUBMITTED : messages.PRODUCTION_PROTOCOL.UPDATED,
    data: await service.update(req.account.id, req.params.seasonId, req.params.protocolId, req.body),
}));

/**
 * POST /expert/seasons/:seasonId/production-protocols/:protocolId/cancel
 * Cancel drafts only; preserve content and record the reason in the status history.
 */
const cancel = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.PRODUCTION_PROTOCOL.CANCELLED,
    data: await service.cancel(req.account.id, req.params.seasonId, req.params.protocolId, req.body),
}));

/**
 * POST /expert/seasons/:seasonId/production-protocols/:protocolId/submit
 * Submit a draft or rejected protocol for owner approval without generating operation schedules.
 */
const submit = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.PRODUCTION_PROTOCOL.SUBMITTED,
    data: await service.submit(req.account.id, req.params.seasonId, req.params.protocolId, req.body),
}));

/**
 * GET /expert/seasons/:seasonId/production-protocol-templates
 */
const templates = asyncHandler(async (req, res) => ResponseHandler.paginated(res,
    await service.templates(req.account.id, req.params.seasonId, req.query)));

/**
 * GET /expert/seasons/:seasonId/production-protocol-templates/:templateId
 */
const templateDetail = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    data: await service.templateDetail(req.account.id, req.params.seasonId, req.params.templateId),
}));

module.exports = {
    getSeason,
    list,
    catalog,
    detail,
    create,
    update,
    cancel,
    submit,
    templates,
    templateDetail,
};
