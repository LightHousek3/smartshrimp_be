const router = require('express').Router({ mergeParams: true });
const { validate } = require('../middlewares');
const controller = require('../controllers/expertTreatmentProtocol.controller');
const validator = require('../validators/expertTreatmentProtocol.validator');

// Authentication and the Expert guard belong to the parent disease-case router.
/**
 * @route   GET /api/v1/expert/disease-cases/:caseId/protocols/context
 * @desc    Get case-scoped authoring context and creation eligibility
 * @access  Private (case EXPERT; historical season access checked by the service)
 */
router.get('/context', validate(validator.getContext), controller.getContext);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/protocols
 * @desc    Create a treatment draft and optionally submit it in the same transaction
 * @access  Private (case EXPERT currently assigned to an ACTIVE season)
 */
router.post('/', validate(validator.create), controller.create);

/**
 * @route   GET /api/v1/expert/disease-cases/:caseId/protocols/:protocolId
 * @desc    Get treatment content, execution evidence, history and available actions
 * @access  Private (case EXPERT; historical season access checked by the service)
 */
router.get('/:protocolId', validate(validator.detail), controller.detail);

/**
 * @route   PATCH /api/v1/expert/disease-cases/:caseId/protocols/:protocolId
 * @desc    Update a DRAFT or REJECTED treatment using its current revision
 * @access  Private (case EXPERT currently assigned to an ACTIVE season)
 */
router.patch('/:protocolId', validate(validator.update), controller.update);

/**
 * @route   DELETE /api/v1/expert/disease-cases/:caseId/protocols/:protocolId
 * @desc    Delete the latest unpublished draft without schedules or successor references
 * @access  Private (case EXPERT currently assigned to an ACTIVE season)
 */
router.delete('/:protocolId', validate(validator.remove), controller.remove);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/protocols/:protocolId/submit
 * @desc    Submit the confirmed revision for Owner review without activating treatment
 * @access  Private (case EXPERT currently assigned to an ACTIVE season)
 */
router.post('/:protocolId/submit', validate(validator.submit), controller.submit);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/protocols/:protocolId/abort
 * @desc    Cancel an APPROVED plan or stop ACTIVE treatment with a care instruction
 * @access  Private (case EXPERT currently assigned to an ACTIVE season)
 */
router.post('/:protocolId/abort', validate(validator.stop), controller.stop);

module.exports = router;
