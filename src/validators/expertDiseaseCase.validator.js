const Joi = require('joi');

const uuid = () => Joi.string().uuid();

const list = {
    query: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(10),
        status: Joi.string().valid('OPEN', 'WAITING_FOR_INFO', 'MONITORING', 'IN_TREATMENT', 'RESOLVED').allow('', null),
        severity: Joi.string().valid('LOW', 'MEDIUM', 'HIGH', 'CRITICAL').allow('', null),
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
            .valid('REQUEST_INFO', 'EXPERT_ASSESSMENT', 'EXPERT_INSTRUCTION')
            .required(),
        message: Joi.string().trim().min(1).max(500).required(),
        switchToMonitoring: Joi.boolean().default(false),
        attachments: Joi.array().items(
            Joi.object({
                fileUrl: Joi.string().uri().required(),
                mediaType: Joi.string().max(100).allow('', null),
                caption: Joi.string().max(255).allow('', null),
            }).unknown(true),
        ).default([]),
    }),
};

const resolve = {
    params: Joi.object({
        caseId: uuid().required(),
    }),
    body: Joi.object({
        resolutionSummary: Joi.string().trim().min(5).max(500).required(),
    }),
};

const abortProtocol = {
    params: Joi.object({
        caseId: uuid().required(),
        protocolId: uuid().required(),
    }),
    body: Joi.object({
        reason: Joi.string().trim().min(5).max(500).required(),
    }),
};

module.exports = {
    list,
    detail,
    respond,
    resolve,
    abortProtocol,
};
