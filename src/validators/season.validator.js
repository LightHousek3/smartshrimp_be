const Joi = require('joi');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');
const name = Joi.string().custom(normalizeWhitespace).min(1).max(255);
const positiveDecimal = (max, precision) =>
    Joi.number().positive().max(max).precision(precision).strict();

const SHRIMP_TYPES = ['WHITELEG', 'BLACK_TIGER'];
const SEASON_STATUSES = ['PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED'];
const EDITABLE_FIELDS = [
    'name',
    'shrimpType',
    'stockingDate',
    'expectedEndDate',
    'initialQuantity',
    'initialAvgWeightG',
];

const dateOnly = Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/u)
    .custom((value, helpers) => {
        const date = new Date(`${value}T00:00:00.000Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
            return helpers.error('date.format');
        }
        return value;
    })
    .messages({
        'string.pattern.base': '{{#label}} must use YYYY-MM-DD format',
        'date.format': '{{#label}} must be a valid calendar date',
    });

const seasonFields = {
    name,
    shrimpType: Joi.string().valid(...SHRIMP_TYPES),
    stockingDate: dateOnly.allow(null),
    expectedEndDate: dateOnly.allow(null),
    initialQuantity: Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER).strict().allow(null),
    initialAvgWeightG: positiveDecimal(9999999.999, 3).allow(null),
};

const validateDateRange = (value, helpers) => {
    if (
        value.stockingDate
        && value.expectedEndDate
        && value.expectedEndDate < value.stockingDate
    ) {
        return helpers.message({ custom: 'expectedEndDate must be on or after stockingDate' });
    }
    return value;
};

const seasonParams = Joi.object({ seasonId: uuid.required() });

const getSeasons = {
    query: Joi.object({
        farmId: uuid,
        pondId: uuid,
        status: Joi.string().valid(...SEASON_STATUSES),
        search: Joi.string().trim().max(255).allow('').default(''),
        cursor: uuid,
        limit: Joi.number().integer().min(1).max(100).default(20),
    }),
};

const getSeason = { params: seasonParams };

const createSeason = {
    body: Joi.object({
        pondId: uuid.required(),
        ...seasonFields,
        name: name.required(),
        shrimpType: Joi.string().valid(...SHRIMP_TYPES).required(),
    }).custom(validateDateRange),
};

const updateSeason = {
    params: seasonParams,
    body: Joi.object({
        ...seasonFields,
        expectedUpdatedAt: Joi.date().iso().required(),
    })
        .or(...EDITABLE_FIELDS)
        .custom(validateDateRange),
};

const activateSeason = {
    params: seasonParams,
    body: Joi.object({
        expectedUpdatedAt: Joi.date().iso().required(),
    }),
};

const cancelSeason = {
    params: seasonParams,
    body: Joi.object({
        reason: Joi.string().trim().min(1).required(),
        expectedUpdatedAt: Joi.date().iso().required(),
    }),
};

module.exports = {
    getSeasons,
    getSeason,
    createSeason,
    updateSeason,
    activateSeason,
    cancelSeason,
};
