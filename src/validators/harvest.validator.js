/**
 * Validate harvest identifiers, filters, numeric storage limits, and retry keys at the HTTP boundary.
 * Ownership, current season state, and population limits require service-level database checks.
 */
const Joi = require('joi');
const { ApiError } = require('../utils');

const uuid = Joi.string().uuid({ version: 'uuidv4' }).lowercase();
const params = { seasonId: uuid.required() };
// JSON counts must remain exact before the service converts them to BigInt.
const count = Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).strict();
// Reject excess precision instead of silently rounding the Owner's input.
const decimal = (max, places) => Joi.number().positive().max(max).precision(places).strict();
// Date endpoints are optional independently; reject a reversed range when both are supplied.
const list = {
    params: Joi.object(params),
    query: Joi.object({
        harvestType: Joi.string().valid('PARTIAL', 'FINAL'),
        from: Joi.date().iso(),
        to: Joi.date().iso(),
        cursor: uuid,
        limit: Joi.number().integer().min(1).max(50).default(20),
    }).custom((value, helpers) => value.from && value.to && value.from > value.to
        ? helpers.message({ custom: 'from must not be after to' }) : value),
};
// Validate the parent season and child harvest identifiers together.
const detail = { params: Joi.object({ ...params, harvestId: uuid.required() }) };
const create = {
    params: Joi.object(params),
    body: Joi.object({
        harvestType: Joi.string().valid('PARTIAL', 'FINAL').required(),
        harvestedAt: Joi.date().iso().required(),
        totalWeightKg: decimal(99999999999.999, 3).required(),
        quantityCount: count.allow(null),
        // Zero means a free sale; null or omission means the price is unknown.
        pricePerKg: decimal(999999999999.99, 2).allow(0, null),
        // Partial harvests need a new population estimate; final harvests leave none.
        estimatedRemainingCount: Joi.when('harvestType', {
            is: 'PARTIAL', then: count.required(), otherwise: Joi.valid(0, null),
        }),
        buyerName: Joi.string().trim().max(255).allow('', null),
        buyerContact: Joi.string().trim().max(255).allow('', null),
        note: Joi.string().trim().max(5000).allow('', null),
    }),
};

// The shared validator only supports params/query/body; validate this header locally.
const idempotency = (req, res, next) => {
    const result = uuid.required().validate(req.get('Idempotency-Key'));
    if (result.error) return next(ApiError.badRequest('Idempotency-Key must be a UUID v4.'));
    // Share the normalized key with the controller without modifying the request body.
    req.harvestKey = result.value;
    return next();
};
module.exports = { list, detail, create, idempotency };
