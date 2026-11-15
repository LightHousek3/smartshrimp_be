const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { expertDiseaseCaseController: controller } = require('../controllers');
const { expertDiseaseCaseValidator: validator } = require('../validators');

const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.EXPERT));
router.use('/:caseId/protocols', require('./expertTreatmentProtocol.route'));

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
 * @desc    Expert sends an ordinary case response
 * @access  Private (EXPERT)
 */
router.post('/:caseId/responses', validate(validator.respond), controller.respond);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/care
 * @desc    Confirm a care decision for the current post-treatment suspension
 * @access  Private (currently assigned EXPERT)
 */
router.post('/:caseId/care', validate(validator.care), controller.care);

/**
 * @route   POST /api/v1/expert/disease-cases/:caseId/resolve
 * @desc    Expert resolves the case with mandatory clinical summary
 * @access  Private (EXPERT)
 */
router.post('/:caseId/resolve', validate(validator.resolve), controller.resolve);

module.exports = router;
