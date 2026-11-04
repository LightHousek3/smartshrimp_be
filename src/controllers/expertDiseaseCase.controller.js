const { expertDiseaseCaseService: service } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /api/v1/expert/disease-cases
 * List disease cases assigned to this expert.
 */
const list = asyncHandler(async (req, res) => {
    const result = await service.list(req.account.id, req.query);
    return ResponseHandler.paginated(res, {
        data: result.data,
        meta: result.meta,
        message: result.message,
    });
});

/**
 * GET /api/v1/expert/disease-cases/:caseId
 * Get detail of a disease case.
 */
const detail = asyncHandler(async (req, res) => {
    const data = await service.detail(req.account.id, req.params.caseId);
    return ResponseHandler.success(res, {
        message: messages.DISEASE_CASE.FETCHED,
        data,
    });
});

/**
 * POST /api/v1/expert/disease-cases/:caseId/responses
 * Expert responds to the case.
 */
const respond = asyncHandler(async (req, res) => {
    const data = await service.respond(req.account.id, req.params.caseId, req.body);
    return ResponseHandler.created(res, {
        message: messages.DISEASE_CASE.RESPONSE_SENT,
        data,
    });
});

/**
 * POST /api/v1/expert/disease-cases/:caseId/resolve
 * Mark the case as resolved with resolution summary.
 */
const resolve = asyncHandler(async (req, res) => {
    const data = await service.resolve(req.account.id, req.params.caseId, req.body);
    return ResponseHandler.success(res, {
        message: messages.DISEASE_CASE.RESOLVED,
        data,
    });
});

/**
 * POST /api/v1/expert/disease-cases/:caseId/protocols/:protocolId/abort
 * Emergency abort protocol for a disease case (BR-TRT-01, 02, 03).
 */
const abortProtocol = asyncHandler(async (req, res) => {
    const data = await service.abortProtocol(
        req.account.id,
        req.params.caseId,
        req.params.protocolId,
        req.body,
    );
    return ResponseHandler.success(res, {
        message: messages.DISEASE_CASE.PROTOCOL_ABORTED,
        data,
    });
});

module.exports = {
    list,
    detail,
    respond,
    resolve,
    abortProtocol,
};
