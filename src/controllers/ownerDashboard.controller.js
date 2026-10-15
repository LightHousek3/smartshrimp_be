const { ownerDashboardService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /api/v1/owner/dashboard
 * Return the operational overview for the authenticated farm owner.
 */
const getOverview = asyncHandler(async (req, res) => {
    const data = await ownerDashboardService.getOverview(req.account.id);
    ResponseHandler.success(res, { message: messages.OWNER_DASHBOARD.FETCHED, data });
});

/**
 * GET /api/v1/owner/dashboard/finance
 * Return monthly income, cost, and totals for the validated period and optional farm filter.
 */
const getFinance = asyncHandler(async (req, res) => {
    const data = await ownerDashboardService.getFinance(req.account.id, req.query);
    ResponseHandler.success(res, { message: messages.OWNER_DASHBOARD.FINANCE_FETCHED, data });
});

module.exports = { getOverview, getFinance };
