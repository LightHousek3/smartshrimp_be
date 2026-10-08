const express = require('express');
const { expertSeasonController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { expertSeasonValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
router.get('/', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertSeasonValidator.getAssignedSeasons),
    expertSeasonController.getAssignedSeasons);

module.exports = router;
