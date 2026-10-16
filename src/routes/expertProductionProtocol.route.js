const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { expertProductionProtocolController: controller } = require('../controllers');
const { expertProductionProtocolValidator: validator } = require('../validators');

// Preserve seasonId from the parent /expert/seasons/:seasonId router.
const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.EXPERT));

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/production-protocols
 * @desc    List production protocol versions with pagination
 * @access  Private (EXPERT assigned to the season; historical access for ended seasons)
 */
router.get('/', validate(validator.list), controller.list);

/**
 * @route   POST /api/v1/expert/seasons/:seasonId/production-protocols
 * @desc    Create a draft and optionally submit it for approval atomically
 * @access  Private (currently assigned EXPERT; PLANNING or ACTIVE season)
 */
router.post('/', validate(validator.create), controller.create);

/**
 * @route   GET /api/v1/expert/seasons/:seasonId/production-protocols/:protocolId
 * @desc    Get protocol content, status history and available actions
 * @access  Private (EXPERT assigned to the season; historical access for ended seasons)
 */
router.get('/:protocolId', validate(validator.detail), controller.detail);

/**
 * @route   PATCH /api/v1/expert/seasons/:seasonId/production-protocols/:protocolId
 * @desc    Update a DRAFT or REJECTED protocol using its current revision
 * @access  Private (currently assigned EXPERT; PLANNING or ACTIVE season)
 */
router.patch('/:protocolId', validate(validator.update), controller.update);

/**
 * @route   POST /api/v1/expert/seasons/:seasonId/production-protocols/:protocolId/cancel
 * @desc    Cancel a DRAFT with a reason while preserving content and history
 * @access  Private (currently assigned EXPERT; PLANNING or ACTIVE season)
 */
router.post('/:protocolId/cancel', validate(validator.cancel), controller.cancel);

/**
 * @route   POST /api/v1/expert/seasons/:seasonId/production-protocols/:protocolId/submit
 * @desc    Submit a DRAFT or REJECTED protocol for owner approval using its current revision
 * @access  Private (currently assigned EXPERT; PLANNING or ACTIVE season)
 */
router.post('/:protocolId/submit', validate(validator.submit), controller.submit);

module.exports = router;
