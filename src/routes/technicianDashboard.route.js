const express = require('express');
const { technicianDashboardController } = require('../controllers');
const { technicianDashboardValidator } = require('../validators');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

/**
 * @route   GET /api/v1/technician/dashboard
 * @desc    Read technician overview and today's remaining schedules grouped by season
 * @access  Technician
 */
router.get('/', authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN),
    validate(technicianDashboardValidator.getOverview), technicianDashboardController.getOverview);

module.exports = router;
