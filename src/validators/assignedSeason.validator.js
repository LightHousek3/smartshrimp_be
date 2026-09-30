const Joi = require('joi');
const { SEASON_STATUS } = require('../constants');

const getAssignedSeasons = {
    query: Joi.object().keys({
        status: Joi.string().uppercase().valid(...Object.values(SEASON_STATUS)),
        search: Joi.string().trim().max(255).allow(''),
        farmId: Joi.string().uuid({ version: 'uuidv4' }),
        limit: Joi.number().integer().min(10).max(50).default(20),
        cursor: Joi.string().max(1000),
    }),
};

const getAssignedSeason = {
    params: Joi.object().keys({
        seasonId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
};

module.exports = { getAssignedSeasons, getAssignedSeason };
