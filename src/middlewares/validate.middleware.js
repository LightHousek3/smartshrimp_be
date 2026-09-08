const Joi = require('joi');
const { ApiError } = require('../utils');
const { httpStatus } = require('../constants');
const pick = require('../utils/pick');

/**
 * Validate request against a Joi schema.
 * Validates req.params, req.query, and req.body based on schema definition.
 *
 * @param {Object} schema - Joi validation schema with keys: params, query, body
 * @returns {Function} Express middleware
 *
 * @example
 * router.post('/users', validate(userValidator.createUser), controller.createUser);
 */
const validate = (schema) => (req, res, next) => {
    const validSchema = pick(schema, ['params', 'query', 'body']);
    const object = pick(req, Object.keys(validSchema));

    const { value, error } = Joi.compile(validSchema)
        .prefs({ errors: { label: 'key' }, abortEarly: false })
        .validate(object);

    if (error) {
        const errorMessage = error.details
            .map((detail) => detail.message)
            .join(', ');
        return next(new ApiError(httpStatus.BAD_REQUEST, errorMessage));
    }

    // Assign validated values back to request
    Object.assign(req, value);
    return next();
};

module.exports = validate;
