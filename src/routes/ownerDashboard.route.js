const express = require('express');
const { ownerDashboardController } = require('../controllers');
const { ownerDashboardValidator } = require('../validators');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

/**
 * @route   GET /api/v1/owner/dashboard
 * @desc    Get the authenticated owner's operational overview, including scoped alert and inventory links
 * @access  Owner
 */
router.get('/', authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER),
    validate(ownerDashboardValidator.getOverview), ownerDashboardController.getOverview);

/**
 * @route   GET /api/v1/owner/dashboard/finance
 * @desc    Get monthly income, cost, and profit for the owner's selected period and farm
 * @access  Owner
 */
router.get('/finance', authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER),
    validate(ownerDashboardValidator.getFinance), ownerDashboardController.getFinance);

module.exports = router;
