const { technicianDashboardService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/** GET /technician/dashboard — a read-only snapshot scoped to the authenticated technician. */
const getOverview = asyncHandler(async (req, res) => {
    const data = await technicianDashboardService.getOverview(req.account.id);
    ResponseHandler.success(res, { message: messages.TECHNICIAN_DASHBOARD.FETCHED, data });
});

module.exports = { getOverview };
