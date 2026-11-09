const { adminDashboardService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getAdminDashboard = asyncHandler(async (req, res) => {
    const data = await adminDashboardService.getSystemOverview();
    ResponseHandler.success(res, {
        message: messages.ADMIN_DASHBOARD.FETCHED,
        data,
    });
});

module.exports = {
    getAdminDashboard,
};
