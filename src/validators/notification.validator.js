const Joi = require('joi');
const { NOTIFICATION_TYPE } = require('../constants');

// Notification IDs and pagination cursors share the same UUID v4 format.
const notificationId = Joi.string().uuid({ version: 'uuidv4' });
// These group names match the type mappings in notification.service.js.
const notificationGroup = Joi.string().valid(
    'disease',
    'protocol',
    'season',
    'system',
);
const notificationParams = Joi.object().keys({
    notificationId: notificationId.required(),
});

/**
 * Validate GET /notifications filters and pagination before calling the service.
 * Default to 20 results and all read states; limit each request to 100 results.
 * Exact type filters must match the shared NOTIFICATION_TYPE enum values.
 */
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
        // Enforce rules involving multiple query fields after validating each field.
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

/**
 * Validate the notification UUID for GET /notifications/:notificationId.
 * Recipient ownership is checked by the service using the authenticated account.
 */
const getNotification = {
    params: notificationParams,
};

module.exports = {
    getListNotification,
    getNotification,
};
