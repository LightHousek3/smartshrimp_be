const { aiDiagnosisService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/** Return a committed diagnosis; the upload lifecycle middleware forwards asynchronous errors. */
const createDiagnosis = async (req, res) => {
    const data = await aiDiagnosisService.createDiagnosis(
        req.account.id,
        req.params.seasonId,
        req.files,
    );
    ResponseHandler.created(res, { message: messages.AI_DIAGNOSIS.CREATED, data });
};
/** Return the technician's scoped history using the shared paginated response envelope. */
const listDiagnoses = asyncHandler(async (req, res) => {
    const { diagnoses, meta } = await aiDiagnosisService.listDiagnoses(
        req.account.id,
        req.params.seasonId,
        req.query,
    );
    ResponseHandler.paginated(res, {
        message: messages.AI_DIAGNOSIS.LIST_FETCHED,
        data: diagnoses,
        meta,
    });
});
/** Return one owned result and temporary access to its stored input images. */
const getDiagnosis = asyncHandler(async (req, res) => {
    const data = await aiDiagnosisService.getDiagnosis(
        req.account.id,
        req.params.seasonId,
        req.params.diagnosisId,
    );
    ResponseHandler.success(res, { message: messages.AI_DIAGNOSIS.DETAIL_FETCHED, data });
});

module.exports = { createDiagnosis, listDiagnoses, getDiagnosis };
