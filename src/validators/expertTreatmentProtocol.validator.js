const Joi = require('joi');
const production = require('./expertProductionProtocol.validator');
const { messages } = require('../constants');
const params = Joi.object({ caseId: Joi.string().uuid().required() });
const protocolParams = params.keys({ protocolId: Joi.string().uuid().required() });
// Reuse stage, material, dose and revision validation; treatment cannot import a production template.
const treatment = {
    templateId: Joi.valid(null),
    templateVersionNo: Joi.forbidden(),
    // Drafts may omit the anchor. Supplied timestamps must identify an absolute instant.
    treatmentStartAt: Joi.date()
        .iso()
        .allow(null)
        .custom((value, helpers) => {
            if (
                typeof helpers.original === 'string' &&
                !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(helpers.original)
            )
                return helpers.message(messages.TREATMENT_PROTOCOL.START_TIMEZONE_REQUIRED);
            return value;
        }),
    rollingWindowDays: Joi.number().valid(3).default(3),
};
const getContext = { params, query: Joi.object({}).unknown(false) };
const detail = { params: protocolParams, query: Joi.object({}).unknown(false) };
const create = { params, body: production.create.body.keys(treatment) };
const update = { params: protocolParams, body: production.update.body.keys(treatment) };
const reason = Joi.string().trim().min(1).max(500).required();
const remove = { params: protocolParams, body: production.remove.body };
const submit = { params: protocolParams, body: production.submit.body };
// Stopping requires both an explanation and an explicit production-care choice.
const stop = {
    params: protocolParams,
    body: production.submit.body.keys({ reason, resumeProduction: Joi.boolean().required() }),
};

module.exports = { getContext, detail, create, update, remove, submit, stop };
