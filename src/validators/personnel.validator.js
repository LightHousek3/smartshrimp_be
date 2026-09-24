const Joi = require('joi');
const { ACCOUNT_ROLE, ACCOUNT_STATUS } = require('../constants');

const uuid = Joi.string().uuid({ version: 'uuidv4' });

const getListPersonnel = {
    query: Joi.object().keys({
        cursor: uuid,
        limit: Joi.number().integer().min(1).max(100).default(20),
        role: Joi.string().valid(ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT),
        status: Joi.string().valid(...Object.values(ACCOUNT_STATUS)),
        search: Joi.string().trim().max(255),
        sortBy: Joi.string().valid('identity', 'createdAt').default('identity'),
        sortOrder: Joi.string().valid('asc', 'desc').default('asc'),
    }),
};

const getPersonnel = {
    params: Joi.object().keys({ personnelId: uuid.required() }),
};

module.exports = { getListPersonnel, getPersonnel };
