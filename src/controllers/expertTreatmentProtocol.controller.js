const service = require('../services/expertTreatmentProtocol.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /expert/disease-cases/:caseId/protocols/context
 * Return case-scoped authoring context using the authenticated Expert identity.
 */
const getContext = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        data: await service.getContext(req.account.id, req.params.caseId),
    }),
);
/**
 * GET /expert/disease-cases/:caseId/protocols/:protocolId
 * Return prescription content and execution evidence in one detail response.
 */
const detail = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        data: await service.detail(req.account.id, req.params.caseId, req.params.protocolId),
    }),
);
/**
 * POST /expert/disease-cases/:caseId/protocols
 * Save the case-bound draft; the service also handles optional atomic submission.
 */
const create = asyncHandler(async (req, res) =>
    ResponseHandler.created(res, {
        message: messages.PRODUCTION_PROTOCOL.CREATED,
        data: await service.create(req.account.id, req.params.caseId, req.body),
    }),
);
/**
 * PATCH /expert/disease-cases/:caseId/protocols/:protocolId
 * Pass validated edits and their revision to the shared authoring workflow.
 */
const update = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        message: messages.PRODUCTION_PROTOCOL.UPDATED,
        data: await service.update(
            req.account.id,
            req.params.caseId,
            req.params.protocolId,
            req.body,
        ),
    }),
);
/**
 * DELETE /expert/disease-cases/:caseId/protocols/:protocolId
 * Return the deleted draft identity after all removal guards pass.
 */
const remove = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        message: messages.PRODUCTION_PROTOCOL.DRAFT_DELETED,
        data: await service.remove(
            req.account.id,
            req.params.caseId,
            req.params.protocolId,
            req.body,
        ),
    }),
);
/**
 * POST /expert/disease-cases/:caseId/protocols/:protocolId/submit
 * Submit the displayed revision for Owner review without changing the case to IN_TREATMENT.
 */
const submit = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        message: messages.PRODUCTION_PROTOCOL.SUBMITTED,
        data: await service.submit(
            req.account.id,
            req.params.caseId,
            req.params.protocolId,
            req.body,
        ),
    }),
);

/**
 * POST /expert/disease-cases/:caseId/protocols/:protocolId/abort
 * Pass the reason and production-care choice to the transactional stop workflow.
 */
const stop = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        message: messages.DISEASE_CASE.PROTOCOL_ABORTED,
        data: await service.stop(
            req.account.id,
            req.params.caseId,
            req.params.protocolId,
            req.body,
        ),
    }),
);

module.exports = { getContext, detail, create, update, remove, submit, stop };
