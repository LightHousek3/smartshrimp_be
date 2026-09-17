const Joi = require('joi');
const { NOTIFICATION_TYPE } = require('../constants');

const notificationId = Joi.string().uuid({ version: 'uuidv4' });
const notificationParams = Joi.object().keys({
    notificationId: notificationId.required(),
});

const getListNotification = {
    query: Joi.object()
        .keys({
            cursor: notificationId,
            limit: Joi.number().integer().min(1).max(100).default(20),
            readStatus: Joi.string().valid('all', 'read', 'unread').default('all'),
            type: Joi.string().valid(...Object.values(NOTIFICATION_TYPE)),
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

const getNotification = {
    params: notificationParams,
};

module.exports = {
    getListNotification,
    getNotification,
};
