const Joi = require('joi');
const { DISEASE_CASE_STATUS, CASE_SEVERITIES, TECHNICIAN_RESPONSE_TYPES, CASE_LIMITS } = require('../constants');
const uuid = Joi.string().uuid({ version: 'uuidv4' });
const params = Joi.object({ seasonId: uuid.required(), caseId: uuid.required() });
const text = (limit) => Joi.string().trim().min(1).custom((value, helpers) =>
    Array.from(value).length <= limit ? value : helpers.error('string.max', { limit }));
const attachments = Joi.array().items(Joi.string().uri({ scheme: ['https'] }).max(CASE_LIMITS.URL))
    .max(CASE_LIMITS.ATTACHMENTS).unique().default([]);
module.exports = {
    list: { params: Joi.object({ seasonId: uuid.required() }), query: Joi.object({
        status: Joi.string().valid(...Object.values(DISEASE_CASE_STATUS)),
        resolved: Joi.boolean(),
        severity: Joi.string().valid(...CASE_SEVERITIES),
        page: Joi.number().integer().min(1).max(CASE_LIMITS.PAGE).default(1),
        limit: Joi.number().integer().min(1).max(CASE_LIMITS.LIMIT).default(20),
    }).without('status', 'resolved') },
    detail: { params, query: Joi.object({}) },
    create: { params: Joi.object({ seasonId: uuid.required() }), query: Joi.object({}), body: Joi.object({
        title: text(CASE_LIMITS.TITLE).required(), description: text(CASE_LIMITS.TEXT).required(),
        severity: Joi.string().valid(...CASE_SEVERITIES).default('MEDIUM'),
        relatedCaseId: uuid, aiDiagnosisId: uuid, attachments,
    }) },
    respond: { params, query: Joi.object({}), body: Joi.object({
        responseType: Joi.string().valid(...TECHNICIAN_RESPONSE_TYPES).required(),
        message: text(CASE_LIMITS.TEXT).required(), attachments,
        expectedUpdatedAt: Joi.date().iso().required(),
    }) },
};
