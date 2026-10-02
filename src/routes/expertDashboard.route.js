const express = require('express');
const { expertDashboardController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { expertDashboardValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
router.get('/', authenticate, authorize(ACCOUNT_ROLE.EXPERT),
    validate(expertDashboardValidator.getDashboard),
    expertDashboardController.getExpertDashboard);

module.exports = router;
