const Joi = require('joi');
const { DASHBOARD_PERIOD } = require('../constants');

/** Reject impossible calendar dates instead of letting Date silently roll them over. */
const dateOnly = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 0 && date.toISOString().slice(0, 10) === value
        ? value : helpers.error('any.invalid');
});

const getOverview = { query: Joi.object({}).unknown(false) };
const getFinance = {
    query: Joi.object({
        farmId: Joi.string().guid({ version: 'uuidv4' }),
        period: Joi.string().valid(...Object.values(DASHBOARD_PERIOD)).default(DASHBOARD_PERIOD.THIS_MONTH),
        from: Joi.when('period', { is: DASHBOARD_PERIOD.CUSTOM, then: dateOnly.required(), otherwise: Joi.forbidden() }),
        to: Joi.when('period', { is: DASHBOARD_PERIOD.CUSTOM, then: dateOnly.required(), otherwise: Joi.forbidden() }),
    }).unknown(false),
};

module.exports = { getOverview, getFinance };
