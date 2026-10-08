const Joi = require('joi');
const { SEASON_STATUS, SHRIMP_TYPE } = require('../constants');

const getAssignedSeasons = {
    query: Joi.object({
        search: Joi.string().trim().max(255).allow(''),
        status: Joi.string().uppercase().valid(...Object.values(SEASON_STATUS)),
        farmId: Joi.string().uuid({ version: 'uuidv4' }),
        shrimpType: Joi.string().uppercase().valid(...Object.values(SHRIMP_TYPE)),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().valid(10, 20, 50).default(10),
    }).unknown(false),
};

module.exports = { getAssignedSeasons };
