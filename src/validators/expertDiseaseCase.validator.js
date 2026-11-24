const Joi = require('joi');
const { CASE_LIMITS } = require('../constants/diseaseCase');

/**
 * Create a fresh Joi schema for expert case resource identifiers.
 */
const uuid = () => Joi.string().uuid();
const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const list = {
    query: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(10),
        status: Joi.string()
            .valid('OPEN', 'MONITORING', 'IN_TREATMENT', 'RESOLVED', 'action')
            .allow('', null),
        severity: Joi.alternatives()
            .try(
                Joi.string().max(32).custom((value, helpers) => {
                    const values = value.split(',').map(entry => entry.trim());
                    return values.every(entry => severities.includes(entry))
                        ? [...new Set(values)] : helpers.error('any.invalid');
                }),
                Joi.array().min(1).max(4).unique().items(Joi.string().valid(...severities)),
            )
            .allow('', null),
        needsResponse: Joi.boolean().allow('', null),
        farmId: uuid().allow('', null),
        seasonId: uuid().allow('', null),
        search: Joi.string().trim().max(255).allow('', null),
    }),
};

const detail = {
    params: Joi.object({
        caseId: uuid().required(),
    }),
};

const respond = {
    params: Joi.object({
        caseId: uuid().required(),
    }),
    body: Joi.object({
        responseType: Joi.string()
            .valid('NORMAL').default('NORMAL'),
        message: Joi.string().trim().min(1).max(500).required(),
        replyToResponseId: uuid(),
        attachments: Joi.array().items(
            Joi.object({
                fileUrl: Joi.string().uri({ scheme: ['https'] }).max(CASE_LIMITS.URL).required(),
                mediaType: Joi.string().max(100).allow('', null),
                caption: Joi.string().max(255).allow('', null),
            }).unknown(true),
        ).max(CASE_LIMITS.ATTACHMENTS).default([]),
    }),
};

const resolve = {
    params: Joi.object({
        caseId: uuid().required(),
    }),
    body: Joi.object({
        resolutionSummary: Joi.string().trim().min(5).max(500).required(),
        confirmWithoutProduction: Joi.boolean().default(false),
        expectedUpdatedAt: Joi.date().iso().when('confirmWithoutProduction', { is: true, then: Joi.required() }),
    }),
};

const care = {
    params: Joi.object({ caseId: uuid().required() }),
    body: Joi.object({
        action: Joi.string().valid('MONITOR', 'RESUME_PRODUCTION').required(),
        reason: Joi.string().trim().min(5).max(450).required(),
        expectedUpdatedAt: Joi.date().iso().required(),
        releaseHoldIds: Joi.array().items(uuid()).unique().default([]),
        episodeId: uuid().required(),
        confirmResume: Joi.boolean().when('action', { is: 'RESUME_PRODUCTION', then: Joi.valid(true).required(), otherwise: Joi.forbidden() }),
        expectedProduction: Joi.object({ id: uuid().required(), updatedAt: Joi.date().iso().required() })
            .when('action', { is: 'RESUME_PRODUCTION', then: Joi.required(), otherwise: Joi.forbidden() }),
    }),
};

module.exports = {
    list,
    detail,
    respond,
    care,
    resolve,
};
