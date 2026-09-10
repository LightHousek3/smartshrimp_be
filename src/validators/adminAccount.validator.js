const Joi = require('joi');
const { USER_ROLE, ACCOUNT_STATUS } = require('../constants');

const accountId = Joi.string().uuid({ version: 'uuidv4' });
const creatableRoles = [USER_ROLE.FARM_OWNER, USER_ROLE.TECHNICIAN, USER_ROLE.EXPERT];
const staffRoles = [USER_ROLE.TECHNICIAN, USER_ROLE.EXPERT];
const changeableStatuses = [
    ACCOUNT_STATUS.ACTIVE,
    ACCOUNT_STATUS.INACTIVE,
    ACCOUNT_STATUS.BLOCKED,
];

const getListAccount = {
    query: Joi.object()
        .keys({
            cursor: accountId,
            limit: Joi.number().integer().min(1).max(100).default(20),
            role: Joi.string().valid(...Object.values(USER_ROLE)),
            status: Joi.string().valid(...Object.values(ACCOUNT_STATUS)),
            managedByOwnerId: accountId,
            search: Joi.string().trim().max(255),
            createdFrom: Joi.date().iso(),
            createdTo: Joi.date().iso(),
        })
        .custom((value, helpers) => {
            if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
                return helpers.message({ custom: '"createdFrom" must not be after "createdTo"' });
            }
            return value;
        }),
};

const getAccount = {
    params: Joi.object().keys({
        accountId: accountId.required(),
    }),
};

const createAccount = {
    body: Joi.object().keys({
        email: Joi.string().trim().lowercase().email().max(320).required(),
        role: Joi.string().valid(...creatableRoles).required(),
        managedByOwnerId: Joi.when('role', {
            is: Joi.valid(...staffRoles),
            then: accountId.required(),
            otherwise: Joi.forbidden(),
        }),
    }),
};

const resendActivation = {
    params: Joi.object().keys({
        accountId: accountId.required(),
    }),
};

const updateAccountStatus = {
    params: Joi.object().keys({
        accountId: accountId.required(),
    }),
    body: Joi.object().keys({
        status: Joi.string()
            .valid(...changeableStatuses)
            .required(),
        reason: Joi.string().trim().min(5).max(500).required(),
    }),
};

module.exports = {
    getListAccount,
    getAccount,
    createAccount,
    resendActivation,
    updateAccountStatus,
};
