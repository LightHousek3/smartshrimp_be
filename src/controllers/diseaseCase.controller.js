const { diseaseCaseService } = require('../services');
const { ResponseHandler, asyncHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /api/v1/me/seasons/:seasonId/disease-cases
 * List disease cases for the assigned technician within a season.
 * Supports pagination and filtering by status, resolved group, or severity.
 */
const list = asyncHandler(async (req, res) => {
    const { data, meta } = await diseaseCaseService.listCases(req.account.id, req.params.seasonId, req.query);
    ResponseHandler.paginated(res, { data, meta, message: messages.DISEASE_CASE.FETCHED });
});

/**
 * GET /api/v1/me/seasons/:seasonId/disease-cases/:caseId
 * Get detailed information of a specific disease case, including snapshots, conversation, and status history.
 */
const detail = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, { data: await diseaseCaseService.getCase(req.account.id, req.params.seasonId, req.params.caseId),
        message: messages.DISEASE_CASE.FETCHED });
});

/**
 * POST /api/v1/me/seasons/:seasonId/disease-cases
 * Create a new disease case for an active season with evidence attachments, optional AI diagnosis, and historical logs snapshot.
 */
const create = asyncHandler(async (req, res) => {
    ResponseHandler.created(res, { data: await diseaseCaseService.createCase(req.account.id, req.params.seasonId, req.body),
        message: messages.DISEASE_CASE.CREATED });
});

/**
 * POST /api/v1/me/seasons/:seasonId/disease-cases/:caseId/responses
 * Submit a technician response (information, monitoring, treatment result, or emergency alert) with optimistic concurrency check.
 */
const respond = asyncHandler(async (req, res) => {
    ResponseHandler.created(res, { data: await diseaseCaseService.respond(req.account.id, req.params.seasonId, req.params.caseId, req.body),
        message: messages.DISEASE_CASE.RESPONDED });
});
module.exports = { list, detail, create, respond };
