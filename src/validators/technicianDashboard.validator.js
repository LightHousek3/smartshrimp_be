const Joi = require('joi');

/** Scope and today's date are server-owned, never client-selected account or farm IDs. */
const getOverview = { query: Joi.object({}).unknown(false) };
module.exports = { getOverview };
