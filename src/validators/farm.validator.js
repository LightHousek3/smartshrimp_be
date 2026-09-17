const Joi = require('joi');

const farmId = Joi.string().uuid({ version: 'uuidv4' });

const normalizeWhitespace = (value) => value.trim().replace(/\s+/gu, ' ');

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

const getFarm = {
    params: Joi.object().keys({
        farmId: farmId.required(),
    }),
};

const createFarm = {
    body: Joi.object().keys({
        ...farmFields,
        name: farmFields.name.required(),
    }),
};

const updateFarm = {
    params: getFarm.params,
    body: Joi.object().keys(farmFields).min(1),
};

module.exports = {
    getFarm,
    createFarm,
    updateFarm,
    changeArchiveStatus: getFarm,
};
