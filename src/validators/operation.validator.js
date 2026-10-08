const Joi = require('joi');
const { OPERATION_STATUS, OPERATION_TYPE } = require('../constants');

const listSchedules = {
    params: Joi.object().keys({
        seasonId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
    query: Joi.object().keys({
        status: Joi.string().uppercase().valid(...Object.values(OPERATION_STATUS)),
        operationType: Joi.string().uppercase().valid(...Object.values(OPERATION_TYPE)),
        date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('Ngày phải có định dạng YYYY-MM-DD'),
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(50),
    }),
};

const getSchedule = {
    params: Joi.object().keys({
        scheduleId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
};

const executeSchedule = {
    params: Joi.object().keys({
        scheduleId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
    body: Joi.object().keys({
        actualQuantity: Joi.number().positive().required().messages({
            'number.base': 'Số lượng thực tế phải là số',
            'number.positive': 'Số lượng thực tế phải lớn hơn 0',
            'any.required': 'Số lượng thực tế là bắt buộc',
        }),
        actualProductId: Joi.string().uuid({ version: 'uuidv4' }).allow(null),
        executedAt: Joi.date().iso(),
        note: Joi.string().trim().max(1000).allow('', null),
        varianceReason: Joi.string().trim().max(1000).allow('', null),
        idempotencyKey: Joi.string().uuid({ version: 'uuidv4' }).required().messages({
            'string.guid': 'Mã idempotency_key phải là UUID hợp lệ',
            'any.required': 'Mã idempotency_key là bắt buộc',
        }),
    }),
};

const getSeasonStats = {
    params: Joi.object().keys({
        seasonId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
};

module.exports = {
    listSchedules,
    getSchedule,
    executeSchedule,
    getSeasonStats,
};
