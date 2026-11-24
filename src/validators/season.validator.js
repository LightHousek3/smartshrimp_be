const Joi = require('joi');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
/**
 * Use consistent spacing for season names and other validated text.
 */
const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');
const name = Joi.string().custom(normalizeWhitespace).min(1).max(255);

const SHRIMP_TYPES = ['WHITELEG', 'BLACK_TIGER'];
const SEASON_STATUSES = ['PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED'];
const PERSONNEL_ROLES = ['TECHNICIAN', 'EXPERT'];
const EDITABLE_FIELDS = [
    'name',
    'shrimpType',
    'stockingDate',
    'plannedStockingDate',
    'expectedEndDate',
    'initialQuantity',
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
        'string.pattern.base': '{{#label}} phải có định dạng YYYY-MM-DD',
        'date.format': '{{#label}} phải là ngày hợp lệ',
    });

const seasonFields = {
    name,
    shrimpType: Joi.string().valid(...SHRIMP_TYPES),
    stockingDate: dateOnly.allow(null),
    plannedStockingDate: dateOnly.allow(null),
    expectedEndDate: dateOnly.allow(null),
    initialQuantity: Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER).strict().allow(null),
};

/**
 * Reject an expected end date before stocking when both dates are supplied in the request.
 */
const validateDateRange = (value, helpers) => {
    const plannedDate = value.plannedStockingDate ?? value.stockingDate;
    if (plannedDate && value.expectedEndDate && value.expectedEndDate < plannedDate) {
        return helpers.message({ custom: 'Ngày dự kiến kết thúc phải cùng hoặc sau ngày thả giống' });
    }
    return value;
};

const seasonParams = Joi.object({ seasonId: uuid.required() });
const assignmentParams = Joi.object({
    seasonId: uuid.required(),
    role: Joi.string().valid(...PERSONNEL_ROLES).required(),
});

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

const assignPersonnel = {
    params: seasonParams,
    body: Joi.object({
        accountId: uuid.required(),
        role: Joi.string().valid(...PERSONNEL_ROLES).required(),
    }),
};

const replacePersonnel = {
    params: assignmentParams,
    body: Joi.object({
        accountId: uuid.required(),
        expectedAssignmentId: uuid.required(),
        reason: Joi.string().trim().min(1).max(2000).required(),
    }),
};

const createSeason = {
    body: Joi.object({
        pondId: uuid.required(),
        ...seasonFields,
        name: name.required(),
        shrimpType: Joi.string().valid(...SHRIMP_TYPES).required(),
    }).oxor('stockingDate', 'plannedStockingDate').custom(validateDateRange),
};

const updateSeason = {
    params: seasonParams,
    body: Joi.object({
        ...seasonFields,
        expectedUpdatedAt: Joi.date().iso().required(),
    })
        .or(...EDITABLE_FIELDS)
        .oxor('stockingDate', 'plannedStockingDate')
        .custom(validateDateRange),
};

const activateSeason = {
    params: seasonParams,
    body: Joi.object({
        expectedUpdatedAt: Joi.date().iso().required(),
        actualStockingDate: dateOnly.required().messages({
            'any.required': 'Vui lòng xác nhận ngày thả giống thực tế',
        }),
        activationDelayReason: Joi.string().trim().min(1).max(500),
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
    assignPersonnel,
    replacePersonnel,
    createSeason,
    updateSeason,
    activateSeason,
    cancelSeason,
};
