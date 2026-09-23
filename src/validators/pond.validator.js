const Joi = require('joi');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');
const name = Joi.string().custom(normalizeWhitespace).min(1).max(255);
const positiveDecimal = (max) => Joi.number().positive().max(max).precision(2).strict();

const POND_TYPES = ['AQUACULTURE', 'WATER_TREATMENT'];
const POND_STATUSES = ['AVAILABLE', 'MAINTENANCE', 'INACTIVE'];

const farmParams = Joi.object({ farmId: uuid.required() });
const pondParams = Joi.object({
    farmId: uuid.required(),
    pondId: uuid.required(),
});

const pondFields = {
    name,
    areaM2: positiveDecimal(9999999999.99),
    depthM: positiveDecimal(9999.99),
    type: Joi.string().valid(...POND_TYPES),
    status: Joi.string().valid(...POND_STATUSES),
};

const getPonds = {
    params: farmParams,
    query: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        search: Joi.string().trim().max(255).allow('').default(''),
        status: Joi.string().valid(...POND_STATUSES),
        type: Joi.string().valid(...POND_TYPES),
    }),
};

const getPond = { params: pondParams };

const createPond = {
    params: farmParams,
    body: Joi.object({
        ...pondFields,
        name: name.required(),
        areaM2: positiveDecimal(9999999999.99).required(),
        depthM: positiveDecimal(9999.99).required(),
    }),
};

const updatePond = {
    params: pondParams,
    body: Joi.object(pondFields).min(1),
};

module.exports = {
    getPonds,
    getPond,
    createPond,
    updatePond,
    deletePond: getPond,
};
