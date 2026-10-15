const Joi = require('joi');
const { WATER_METRIC_DEFINITIONS, WATER_NOTE_MAX_LENGTH } = require('../constants');

/**
 * Validators cho nhật ký đo nước (water_quality_logs).
 * - Khoảng vật lý khớp DB CHECK trong smartshrimp.sql (BR-WATER-01).
 * - recordedAt vượt quá hiện tại +5 phút bị chặn ở service (D3), vì Joi
 *   không tính được "now" động tại thời điểm validate.
 */

const seasonIdParam = Joi.string().uuid({ version: 'uuidv4' }).required();

const metricSchemas = Object.fromEntries(
    Object.entries(WATER_METRIC_DEFINITIONS).map(([field, { inputMin, inputMax }]) => {
        const schema = Joi.number().min(inputMin);
        return [field, inputMax === null ? schema : schema.max(inputMax)];
    }),
);

const getMetadata = {
    params: Joi.object().keys({ seasonId: seasonIdParam }),
};

const metricKeys = Object.keys(metricSchemas);

const createWaterLog = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
    }),
    body: Joi.object()
        .keys({
            recordedAt: Joi.date().iso().required(),
            ...metricSchemas,
            note: Joi.string().trim().max(WATER_NOTE_MAX_LENGTH).allow('', null),
        })
        .or(...metricKeys)
        .messages({
            'object.missing': 'Phải nhập ít nhất một chỉ số đo',
        }),
};

const listWaterLogs = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
    }),
    query: Joi.object().keys({
        from: Joi.date().iso(),
        to: Joi.date().iso().min(Joi.ref('from')),
        includeVoided: Joi.boolean().default(false),
        filter: Joi.string().valid('all', 'warning', 'voided'),
        includeCounts: Joi.boolean().default(false),
        limit: Joi.number().integer().min(1).max(50).default(20),
        cursor: Joi.string().max(1000),
    }),
};

const voidWaterLog = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
        logId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
    body: Joi.object().keys({
        voidReason: Joi.string().trim().min(1).max(1000).required(),
    }),
};

const getStatistics = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
    }),
    query: Joi.object().keys({
        from: Joi.date().iso().required(),
        to: Joi.date().iso().min(Joi.ref('from')).required(),
        granularity: Joi.string().valid('day', 'week').default('day'),
    }),
};

module.exports = {
    getMetadata,
    createWaterLog,
    listWaterLogs,
    voidWaterLog,
    getStatistics,
};
