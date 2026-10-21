const Joi = require('joi');
const { HEALTH_STATUS } = require('../constants');

/**
 * Validators cho nhật ký sức khỏe tôm (shrimp_health_logs).
 * - Khoảng giá trị khớp CHECK constraints trong PostgreSQL:
 *   + sample_size IS NULL OR sample_size > 0
 *   + avg_weight_g IS NULL OR avg_weight_g > 0
 *   + avg_length_cm IS NULL OR avg_length_cm > 0
 *   + mortality_count >= 0
 *   + estimated_population IS NULL OR estimated_population >= 0
 *   + estimated_biomass_kg IS NULL OR estimated_biomass_kg >= 0
 *   + health_status IN ('EXCELLENT', 'GOOD', 'WARNING', 'CRITICAL')
 */

const seasonIdParam = Joi.string().uuid({ version: 'uuidv4' }).required();
const logIdParam = Joi.string().uuid({ version: 'uuidv4' }).required();

const createShrimpHealthLog = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
    }),
    body: Joi.object()
        .keys({
            recordedAt: Joi.date().iso().required(),
            sampleSize: Joi.number().integer().positive().allow(null),
            avgWeightG: Joi.number().positive().max(1000).allow(null),
            avgLengthCm: Joi.number().positive().max(100).allow(null),
            mortalityCount: Joi.number().integer().min(0).allow(null),
            estimatedPopulation: Joi.number().integer().min(0).allow(null),
            estimatedBiomassKg: Joi.number().min(0).allow(null),
            healthStatus: Joi.string()
                .valid(...Object.values(HEALTH_STATUS)),
            note: Joi.string().trim().max(2000).allow('', null),
        })
        .or(
            'sampleSize',
            'avgWeightG',
            'avgLengthCm',
            'mortalityCount',
            'estimatedPopulation',
            'estimatedBiomassKg',
            'healthStatus',
            'note',
        )
        .messages({
            'object.missing': 'Phải nhập ít nhất một chỉ số sức khỏe hoặc thể trạng tôm',
        }),
};

const listShrimpHealthLogs = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
    }),
    query: Joi.object().keys({
        from: Joi.date().iso(),
        to: Joi.date().iso().min(Joi.ref('from')),
        includeVoided: Joi.boolean().default(false),
        filter: Joi.string().valid('all', 'valid', 'voided'),
        healthStatus: Joi.string().valid(...Object.values(HEALTH_STATUS)),
        includeCounts: Joi.boolean().default(false),
        limit: Joi.number().integer().min(1).max(50).default(20),
        cursor: Joi.string().max(1000),
    }),
};

const getShrimpHealthLogDetail = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
        logId: logIdParam,
    }),
};

const voidShrimpHealthLog = {
    params: Joi.object().keys({
        seasonId: seasonIdParam,
        logId: logIdParam,
    }),
    body: Joi.object().keys({
        voidReason: Joi.string().trim().min(1).max(1000).required().messages({
            'string.empty': 'Lý do hủy bản ghi là bắt buộc',
            'any.required': 'Lý do hủy bản ghi là bắt buộc',
        }),
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
    createShrimpHealthLog,
    listShrimpHealthLogs,
    getShrimpHealthLogDetail,
    voidShrimpHealthLog,
    getStatistics,
};
