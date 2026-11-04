const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { expertDiseaseCaseController: controller } = require('../controllers');
const { expertDiseaseCaseValidator: validator } = require('../validators');

const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.EXPERT));

/**
 * @route   GET /api/v1/expert/disease-cases
 * @desc    List disease cases assigned to expert
 * @access  Private (EXPERT)
 */
router.get('/', validate(validator.list), controller.list);

/**
 * @route   GET /api/v1/expert/disease-cases/:caseId
 * @desc    Get detailed disease case with timeline, snapshots and protocols
 * @access  Private (EXPERT)
 */
router.get('/:caseId', validate(validator.detail), controller.detail);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/responses
 * @desc    Expert sends a response (REQUEST_INFO, EXPERT_ASSESSMENT, EXPERT_INSTRUCTION)
 * @access  Private (EXPERT)
 */
router.post('/:caseId/responses', validate(validator.respond), controller.respond);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/resolve
 * @desc    Expert resolves the case with mandatory clinical summary
 * @access  Private (EXPERT)
 */
router.post('/:caseId/resolve', validate(validator.resolve), controller.resolve);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/protocols/:protocolId/abort
 * @desc    Emergency abort treatment protocol (BR-TRT-01/02/03)
 * @access  Private (EXPERT)
 */
router.post(
    '/:caseId/protocols/:protocolId/abort',
    validate(validator.abortProtocol),
    controller.abortProtocol,
);

module.exports = router;
