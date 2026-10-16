const Joi = require('joi');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const idempotencyKeySchema = Joi.string().uuid({ version: 'uuidv4' }).required();

/**
 * Require a UUID v4 Idempotency-Key and store its normalized value on the request.
 * The inventory service uses this key to replay stock transactions on retry.
 */
const requireIdempotencyKey = (req, res, next) => {
    const { value, error } = idempotencyKeySchema.validate(req.get('Idempotency-Key'));
    if (error) {
        return next(
            new ApiError(
                httpStatus.BAD_REQUEST,
                messages.INVENTORY.IDEMPOTENCY_KEY_REQUIRED,
            ),
        );
    }
    req.idempotencyKey = value.toLowerCase();
    return next();
};

module.exports = { requireIdempotencyKey };
