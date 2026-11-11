const { ownerDiseaseCaseService: service } = require('../services');
const { messages } = require('../constants');
const { asyncHandler, ResponseHandler } = require('../utils');

/** Return the requested page and both tab counts for the authenticated owner. */
const list = asyncHandler(async (req, res) => {
    const { data, meta } = await service.list(req.account.id, req.query);
    return ResponseHandler.paginated(res, { data, meta, message: messages.DISEASE_CASE.LIST_FETCHED });
});

/** Return the clinical record and its timeline in the authenticated owner scope. */
const detail = asyncHandler(async (req, res) =>
    ResponseHandler.success(res, {
        data: await service.detail(req.account.id, req.params.caseId),
        message: messages.DISEASE_CASE.FETCHED,
    }));

module.exports = { list, detail };
