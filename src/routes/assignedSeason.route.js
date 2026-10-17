const express = require('express');
const { assignedSeasonController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { assignedSeasonValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
// The service further narrows Technician access to current season assignments.
router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   GET /api/v1/me/seasons
 * @desc    List aquaculture seasons currently assigned to the authenticated Technician
 * @access  Technician
 */
router.get('/', validate(assignedSeasonValidator.getAssignedSeasons), assignedSeasonController.getAssignedSeasons);

/**
 * @route   GET /api/v1/me/seasons/:seasonId
 * @desc    Get details of a season currently assigned to the authenticated Technician
 * @access  Technician
 */
router.get('/:seasonId', validate(assignedSeasonValidator.getAssignedSeason), assignedSeasonController.getAssignedSeason);

module.exports = router;
