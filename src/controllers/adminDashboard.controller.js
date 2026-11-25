const { adminDashboardService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /admin/dashboard
 * Retrieves system overview metrics, daily analytics, and account status breakdown.
 */
const getAdminDashboard = asyncHandler(async (req, res) => {
    const data = await adminDashboardService.getSystemOverview();
    ResponseHandler.success(res, {
        message: messages.ADMIN_DASHBOARD.FETCHED,
        data,
    });
});

/**
 * GET /admin/dashboard/services-health
 * Checks live availability of AI classification and RAG services for admin monitoring.
 */
const getServicesHealth = asyncHandler(async (req, res) => {
    const data = await adminDashboardService.getServicesHealth();
    ResponseHandler.success(res, {
        message: messages.ADMIN_DASHBOARD.SERVICES_HEALTH_FETCHED,
        data,
    });
});

module.exports = {
    getAdminDashboard,
    getServicesHealth,
};
