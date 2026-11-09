const express = require('express');
const { adminDashboardController } = require('../controllers');
const { authenticate, authorize } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.get(
    '/',
    authenticate,
    authorize(ACCOUNT_ROLE.ADMIN),
    adminDashboardController.getAdminDashboard,
);

module.exports = router;
