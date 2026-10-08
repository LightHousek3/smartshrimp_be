const Joi = require('joi');

/**
 * Validators cho nhật ký đo nước (water_quality_logs).
 * - Khoảng vật lý khớp DB CHECK trong smartshrimp.sql (BR-WATER-01).
 * - recordedAt vượt quá hiện tại +5 phút bị chặn ở service (D3), vì Joi
 *   không tính được "now" động tại thời điểm validate.
 */

const seasonIdParam = Joi.string().uuid({ version: 'uuidv4' }).required();

const metricSchemas = {
    temperatureC: Joi.number().min(0).max(50),
    ph: Joi.number().min(0).max(14),
    dissolvedOxygenMgL: Joi.number().min(0),
    salinityPpt: Joi.number().min(0),
    nh3MgL: Joi.number().min(0),
    no2MgL: Joi.number().min(0),
    alkalinityMgLCaCO3: Joi.number().min(0),
    h2sMgL: Joi.number().min(0),
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
            note: Joi.string().trim().max(2000).allow('', null),
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
    createWaterLog,
    listWaterLogs,
    voidWaterLog,
    getStatistics,
};
