const Joi = require('joi');
const { TASK_STATUSES, TASK_LIMITS, messages } = require('../constants');
const uuid = Joi.string().uuid({ version: 'uuidv4' });
const params = Joi.object({ taskId: uuid.required() });
// PostgreSQL VARCHAR limits Unicode code points, so validation uses the same unit.
const boundedText = (limit) => Joi.string().trim().custom((value, helpers) =>
    Array.from(value).length <= limit ? value : helpers.error('string.max', { limit }));
const fields = {
    title: boundedText(TASK_LIMITS.TITLE).min(1),
    description: boundedText(TASK_LIMITS.DESCRIPTION).allow('', null),
    priority: Joi.string().valid('LOW', 'NORMAL', 'HIGH', 'URGENT'),
    dueAt: Joi.date().iso().custom((value, helpers) => value.getTime() > Date.now() + TASK_LIMITS.DEADLINE_LEAD_MS
        ? value : helpers.message(messages.TASK.INVALID_DEADLINE)),
    farmId: uuid,
    seasonId: uuid.allow(null),
    assignedTo: uuid,
};
module.exports = {
    list: { query: Joi.object({
        status: Joi.string().valid(...TASK_STATUSES).default('PENDING'),
        page: Joi.number().integer().min(1).max(1000000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
    }) },
    detail: { params },
    assignedList: { query: Joi.object({
        group: Joi.string().valid('TODO', 'ENDED').default('TODO'),
        page: Joi.number().integer().min(1).max(1000000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
    }) },
    progress: { params, body: Joi.object({
        status: Joi.string().valid('IN_PROGRESS', 'COMPLETED').required(),
    }) },
    options: { query: Joi.object({ farmId: uuid }) },
    create: { body: Joi.object({ ...fields, title: fields.title.required(),
        priority: fields.priority.required(), farmId: uuid.required(), dueAt: fields.dueAt.required(),
    }).or('seasonId', 'assignedTo') },
    update: { params, body: Joi.object(fields).min(1) },
    cancel: { params, body: Joi.object({ reason: boundedText(TASK_LIMITS.CANCELLATION_REASON).min(1).required() }) },
};
