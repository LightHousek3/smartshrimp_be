const Joi = require('joi');
const { ApiError, pick } = require('../utils');
const { httpStatus } = require('../constants');
const validationMessages = require('../constants/validationMessages');
const validationLabels = require('../constants/validationLabels');

// Replace only the label supplied by Joi; keep explicit human-readable schema labels intact.
const displayMessage = (detail) => {
    const label = detail.context?.label;
    if (!label) return detail.message;
    const field = label.replace(/\[\d+\]/g, '').split('.').at(-1);
    const translated = validationLabels[field];
    return translated ? detail.message.replaceAll(label, translated) : detail.message;
};

/**
 * Validate request against a Joi schema.
 * Validates req.params, req.query, and req.body based on schema definition.
 *
 * @param {Object} schema - Joi validation schema with keys: params, query, body
 * @returns {Function} Express middleware
 *
 * @example
 * router.post('/accounts', validate(accountValidator.createAccount), controller.createAccount);
 */
const validate = (schema) => (req, res, next) => {
    const validSchema = pick(schema, ['params', 'query', 'body']);
    const object = pick(req, Object.keys(validSchema));

    const { value, error } = Joi.compile(validSchema)
        .prefs({
            errors: { label: 'key', wrap: { label: false } },
            messages: validationMessages,
            abortEarly: false,
        })
        .validate(object);

    if (error) {
        const errorMessage = [...new Set(error.details.map(displayMessage))].join(' ');
        return next(new ApiError(httpStatus.BAD_REQUEST, errorMessage));
    }

    // Assign validated values back to request
    Object.assign(req, value);
    return next();
};

module.exports = validate;
