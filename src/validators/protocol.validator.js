const Joi = require('joi');
const { PROTOCOL_TYPE, PROTOCOL_STATUS } = require('../constants/protocol');
const uuid = Joi.string().uuid({ version: 'uuidv4' });
const params = Joi.object({ protocolId: uuid.required() }).unknown(false);
const empty = Joi.object({}).unknown(false);
const version = Joi.date().iso().required();
const list = {
    query: Joi.object({
        seasonId: uuid,
        protocolType: Joi.string().valid(...Object.values(PROTOCOL_TYPE)),
        status: Joi.string().valid(...Object.values(PROTOCOL_STATUS).filter((s) => s !== PROTOCOL_STATUS.DRAFT)),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
    }).unknown(false),
};
const detail = { params, query: empty };
const day = {
    params: Joi.object({ protocolId: uuid.required(), day: Joi.number().integer().min(1).max(100000).required() }).unknown(false),
    query: empty,
};
const inventory = { params: Joi.object({ protocolId: uuid.required(), scheduleId: uuid.required() }).unknown(false), query: empty };
const review = {
    params, query: empty,
    body: Joi.object({
        updatedAt: version,
        decision: Joi.string().valid('APPROVE', 'REJECT').required(),
        reason: Joi.when('decision', {
            is: 'REJECT', then: Joi.string().trim().min(1).max(2000).required(), otherwise: Joi.forbidden(),
        }),
    }).unknown(false),
};
module.exports = { list, detail, day, inventory, review };
