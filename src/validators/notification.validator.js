const Joi = require('joi');
const { NOTIFICATION_TYPE } = require('../constants');
const push = require('../constants/pushNotification');

const notificationId = Joi.string().uuid({ version: ['uuidv4', 'uuidv5'] });
const notificationGroup = Joi.string().valid('disease', 'protocol', 'season', 'system');
const notificationParams = Joi.object().keys({
    notificationId: notificationId.required(),
});

const getListNotification = {
    query: Joi.object()
        .keys({
            cursor: notificationId,
            page: Joi.number().integer().min(1),
            limit: Joi.number().integer().min(1).max(100).default(20),
            readStatus: Joi.string().valid('all', 'read', 'unread').default('all'),
            category: Joi.string().valid('action', 'warning'),
            group: notificationGroup,
            type: Joi.string().valid(...Object.values(NOTIFICATION_TYPE)),
            createdFrom: Joi.date().iso(),
            createdTo: Joi.date().iso(),
        })
        .custom((value, helpers) => {
            if (value.cursor && value.page) {
                return helpers.message({ custom: '"cursor" cannot be combined with "page"' });
            }
            if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
                return helpers.message({ custom: '"createdFrom" must not be after "createdTo"' });
            }
            return value;
        }),
};

const getNotification = {
    params: notificationParams,
};

const registerDevice = {
    body: Joi.object({
        deviceId: Joi.string().uuid({ version: 'uuidv4' }).required(),
        token: Joi.string()
            .min(1)
            .max(push.tokenLimit)
            .pattern(/^[\x21-\x7e]+$/)
            .required(),
        platform: Joi.string().valid('android', 'ios').required(),
    }).unknown(false),
};
const unregisterDevice = {
    params: Joi.object({ deviceId: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(
        false,
    ),
};

module.exports = {
    registerDevice,
    unregisterDevice,
    getListNotification,
    getNotification,
};
