const Joi = require('joi');

const farmId = Joi.string().uuid({ version: 'uuidv4' });

const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');

/**
 * Collapse whitespace before length checks so persisted names use a consistent representation.
 */
const normalizedString = ({ max, allowNull = false }) => {
    let schema = Joi.string().custom((value) => normalizeWhitespace(value)).min(1).max(max);
    if (allowNull) schema = schema.allow(null);
    return schema;
};

const farmFields = {
    name: normalizedString({ max: 255 }),
    address: normalizedString({ max: 1000, allowNull: true }),
    latitude: Joi.number().min(-90).max(90).precision(8).strict().allow(null),
    longitude: Joi.number().min(-180).max(180).precision(8).strict().allow(null),
    totalAreaHectares: Joi.number()
        .positive()
        .max(99999999.99)
        .precision(2)
        .strict()
        .allow(null),
};

/**
 * Validate the same UUID boundary for detail and delete; ownership remains a service concern.
 */
const getFarm = {
    params: Joi.object().keys({
        farmId: farmId.required(),
    }),
};

/**
 * Require a name and paired coordinates; numeric limits follow the current SQL precision.
 */
const createFarm = {
    body: Joi.object().keys({
        ...farmFields,
        name: farmFields.name.required(),
    }).and('latitude', 'longitude'),
};

/**
 * Reject empty patches and partial coordinate updates before reaching the transactional service.
 */
const updateFarm = {
    params: getFarm.params,
    body: Joi.object().keys(farmFields).and('latitude', 'longitude').min(1),
};

module.exports = {
    getFarm,
    createFarm,
    updateFarm,
    deleteFarm: getFarm,
};
