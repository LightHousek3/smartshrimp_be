const express = require('express');
const { assignedSeasonController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { assignedSeasonValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));
router.get('/', validate(assignedSeasonValidator.getAssignedSeasons), assignedSeasonController.getAssignedSeasons);
router.get('/:seasonId', validate(assignedSeasonValidator.getAssignedSeason), assignedSeasonController.getAssignedSeason);

module.exports = router;
