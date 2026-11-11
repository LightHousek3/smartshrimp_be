const Joi = require('joi');

const uuid = Joi.string().uuid();

// List requests are tied to one season and one of the two owner tabs.
const list = {
    query: Joi.object({
        seasonId: uuid.required(),
        resolved: Joi.boolean().default(false),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
    }),
};

const detail = {
    params: Joi.object({ caseId: uuid.required() }),
    query: Joi.object({}),
};

module.exports = { list, detail };
