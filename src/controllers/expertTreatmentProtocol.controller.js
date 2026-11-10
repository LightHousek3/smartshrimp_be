const service = require('../services/expertTreatmentProtocol.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getContext = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    data: await service.getContext(req.account.id, req.params.caseId),
}));
const detail = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    data: await service.detail(req.account.id, req.params.caseId, req.params.protocolId),
}));
const create = asyncHandler(async (req, res) => ResponseHandler.created(res, {
    message: messages.PRODUCTION_PROTOCOL.CREATED,
    data: await service.create(req.account.id, req.params.caseId, req.body),
}));
const update = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.PRODUCTION_PROTOCOL.UPDATED,
    data: await service.update(req.account.id, req.params.caseId, req.params.protocolId, req.body),
}));
const cancel = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.PRODUCTION_PROTOCOL.CANCELLED,
    data: await service.cancel(req.account.id, req.params.caseId, req.params.protocolId, req.body),
}));
const submit = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.PRODUCTION_PROTOCOL.SUBMITTED,
    data: await service.submit(req.account.id, req.params.caseId, req.params.protocolId, req.body),
}));

const stop = asyncHandler(async (req, res) => ResponseHandler.success(res, {
    message: messages.DISEASE_CASE.PROTOCOL_ABORTED,
    data: await service.stop(req.account.id, req.params.caseId, req.params.protocolId, req.body),
}));

module.exports = { getContext, detail, create, update, cancel, submit, stop };
