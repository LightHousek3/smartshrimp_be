const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const {
    uploadImages,
    admitUpload,
    completeUpload,
    authorizeDiagnosisUpload,
    diagnosisLimiter,
    noStore,
} = require('../middlewares/aiDiagnosisUpload.middleware');
const { aiDiagnosisController: controller } = require('../controllers');
const { aiDiagnosisValidator: validator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

/** @tag Ai diagnoses */
const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN), noStore);

/**
 * @route GET /api/v1/technician/seasons/:seasonId/ai-diagnoses
 * @desc List the technician's AI requests for a currently assigned season
 * @access Technician
 */
router.get('/', validate(validator.list), controller.listDiagnoses);

/**
 * @route GET /api/v1/technician/seasons/:seasonId/ai-diagnoses/:diagnosisId
 * @desc Get an owned result, input images and processing outcome
 * @access Technician
 */
router.get('/:diagnosisId', validate(validator.detail), controller.getDiagnosis);

/**
 * @route POST /api/v1/technician/seasons/:seasonId/ai-diagnoses
 * @desc Classify 1-5 shrimp images in an active assigned season and save the result
 * @access Technician
 */
router.post(
    '/',
    validate(validator.createParams),
    diagnosisLimiter,
    authorizeDiagnosisUpload,
    admitUpload,
    uploadImages,
    validate(validator.create),
    completeUpload(controller.createDiagnosis),
);

module.exports = router;
