/**
 * Admin dashboard routes for platform metrics, summary aggregations, and AI service health checks.
 */

const express = require('express');
const { adminDashboardController } = require('../controllers');
const { authenticate, authorize } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

/**
 * @route   GET /api/v1/admin/dashboard
 * @desc    Get aggregated platform statistics and active account metrics
 * @access  Private (ADMIN)
 */
router.get(
    '/',
    authenticate,
    authorize(ACCOUNT_ROLE.ADMIN),
    adminDashboardController.getAdminDashboard,
);

/**
 * @route   GET /api/v1/admin/dashboard/services-health
 * @desc    Check live health status of AI diagnosis and RAG services
 * @access  Private (ADMIN)
 */
router.get(
    '/services-health',
    authenticate,
    authorize(ACCOUNT_ROLE.ADMIN),
    adminDashboardController.getServicesHealth,
);

module.exports = router;
