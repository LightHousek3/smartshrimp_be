const express = require('express');
const { ACCOUNT_ROLE } = require('../constants');
const { authenticate, authorize, validate } = require('../middlewares');
const { ownerDiseaseCaseController: controller } = require('../controllers');
const { ownerDiseaseCaseValidator: validator } = require('../validators');

const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/disease-cases
 * @desc    List disease cases in an owned season, with counts for both tabs
 * @access  Farm Owner
 */
router.get('/', validate(validator.list), controller.list);

/**
 * @route   GET /api/v1/owner/disease-cases/:caseId
 * @desc    View a disease case, opening snapshot, evidence, protocols and timeline
 * @access  Farm Owner
 */
router.get('/:caseId', validate(validator.detail), controller.detail);

module.exports = router;
