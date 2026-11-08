const Joi = require('joi');
const { POND_STATUS, POND_TYPE, POND_LIMITS, POND_PAGINATION } = require('../constants');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
// Normalize the stored name; the service applies a stronger key for uniqueness.
const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');
const name = Joi.string().custom(normalizeWhitespace).min(1).max(POND_LIMITS.NAME);
// Reject numeric strings or excess precision in JSON bodies instead of rounding input.
const positiveDecimal = (max) => Joi.number().positive().max(max).precision(2).strict();

// These allowed values come from Prisma via the constants barrel, not local enums.
const POND_TYPES = Object.values(POND_TYPE);
const POND_STATUSES = Object.values(POND_STATUS);

const farmParams = Joi.object({ farmId: uuid.required() });
const pondParams = Joi.object({
    farmId: uuid.required(),
    pondId: uuid.required(),
});

// Reuse optional field rules for PATCH; creation adds its required fields below.
// Cross-field capacity and open-season restrictions belong to the service.
const pondFields = {
    name,
    areaM2: positiveDecimal(POND_LIMITS.AREA_M2),
    depthM: positiveDecimal(POND_LIMITS.DEPTH_M),
    volumeM3: positiveDecimal(POND_LIMITS.VOLUME_M3),
    type: Joi.string().valid(...POND_TYPES),
    status: Joi.string().valid(...POND_STATUSES),
};

/** Validate farm scope and convert query strings/defaults before pagination runs. */
const getPonds = {
    params: farmParams,
    query: Joi.object({
        page: Joi.number().integer().min(1).default(POND_PAGINATION.DEFAULT_PAGE),
        limit: Joi.number().integer().min(1)
            .max(POND_PAGINATION.MAX_LIMIT).default(POND_PAGINATION.DEFAULT_LIMIT),
        search: Joi.string().trim().max(POND_LIMITS.NAME).allow('').default(''),
        status: Joi.string().valid(...POND_STATUSES),
        type: Joi.string().valid(...POND_TYPES),
    }),
};

// ID validation does not establish ownership; the service checks both IDs and owner.
const getPond = { params: pondParams };

/** Require dimensions; omitted usable volume is calculated by the service. */
const createPond = {
    params: farmParams,
    body: Joi.object({
        ...pondFields,
        name: name.required(),
        areaM2: pondFields.areaM2.required(),
        depthM: pondFields.depthM.required(),
    }),
};

// Dimensions are fixed at creation; PATCH may only adjust usable water volume.
const updatePond = {
    params: pondParams,
    body: Joi.object({
        ...pondFields,
        areaM2: Joi.forbidden(),
        depthM: Joi.forbidden(),
    }).min(1),
};

module.exports = {
    getPonds,
    getPond,
    createPond,
    updatePond,
    deletePond: getPond,
};
