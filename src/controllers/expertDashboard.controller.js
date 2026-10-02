const { expertDashboardService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getExpertDashboard = asyncHandler(async (req, res) => {
    const data = await expertDashboardService.getExpertDashboard(req.account.id);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.success(res, { message: messages.EXPERT_DASHBOARD.FETCHED, data });
});

module.exports = { getExpertDashboard };
