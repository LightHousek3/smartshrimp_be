const Joi = require('joi');
const params = Joi.object({ farmId: Joi.string().uuid({ version: 'uuidv4' }).required() });

module.exports = {
    search: { params, query: Joi.object({
        q: Joi.string().trim().max(150).allow('').default(''),
        cursor: Joi.string().pattern(/^\d{1,5}$/u).default('0'),
    }) },
    check: { params, body: Joi.object({ ingredientsText: Joi.string().trim().max(50000).allow('').required() }) },
};
