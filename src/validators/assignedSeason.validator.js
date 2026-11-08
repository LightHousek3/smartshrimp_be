const Joi = require('joi');
const { SEASON_STATUS, ASSIGNED_SEASON_LIMITS } = require('../constants');

/**
 * Bound list size and cursor length before querying current technician assignments.
 * The service validates cursor structure and verifies it belongs to this filtered assignment scope.
 */
const getAssignedSeasons = {
    query: Joi.object().keys({
        status: Joi.string().uppercase().valid(...Object.values(SEASON_STATUS)),
        search: Joi.string().trim().max(ASSIGNED_SEASON_LIMITS.SEARCH_LENGTH).allow(''),
        farmId: Joi.string().uuid({ version: 'uuidv4' }),
        limit: Joi.number().integer()
            .min(ASSIGNED_SEASON_LIMITS.MIN_PAGE_SIZE)
            .max(ASSIGNED_SEASON_LIMITS.MAX_PAGE_SIZE)
            .default(ASSIGNED_SEASON_LIMITS.DEFAULT_PAGE_SIZE),
        cursor: Joi.string().max(ASSIGNED_SEASON_LIMITS.CURSOR_LENGTH),
    }),
};

/**
 * Reject malformed season identifiers before checking the technician assignment.
 */
const getAssignedSeason = {
    params: Joi.object().keys({
        seasonId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
};

const getAssignedSeasonFarms = { query: Joi.object().keys({}) };

module.exports = { getAssignedSeasons, getAssignedSeason, getAssignedSeasonFarms };
