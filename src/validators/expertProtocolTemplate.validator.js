const messages = require('../constants/messages.js');
const Joi = require('joi');
const { SHRIMP_TYPE } = require('../constants');
const {
    ProductCategory,
    ConversionUnit,
    DoseBasis,
    ProductionProtocolTemplateStatus,
} = require('@prisma/client');

const uuid = Joi.string().uuid({ version: 'uuidv4' });
const clock = Joi.string()
    .pattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .required();
const recommendation = Joi.object({
    productCompliance: require('./materialCompliance.validator')
        .productCompliance.keys({
            // Legacy clients may send these fields; only the service can determine their persisted values.
            complianceStatus: Joi.any().strip(),
            reviewNote: Joi.any().strip(),
        })
        .default({
            regulatoryType: 'unclassified',
            complianceStatus: 'draft',
            evidenceUrls: [],
        }),
    // Draft proposals may lack a manufacturer; normalize imported null values to missing input.
    // The service derives completeness after resolving the Owner-scoped manufacturer.
    manufacturerId: uuid.empty(null),
    manufacturer: require('./materialCompliance.validator').manufacturer.empty(
        null
    ),
    name: Joi.string().trim().min(1).max(255).required(),
    description: Joi.string().trim().max(500).allow('', null).default(null),
    category: Joi.string()
        .valid(...Object.values(ProductCategory))
        .required(),
    unit: Joi.string().valid('KG', 'G', 'L', 'ML', 'PACK', 'BOTTLE').required(),
    conversionQuantity: Joi.when('unit', {
        is: Joi.valid('PACK', 'BOTTLE'),
        then: Joi.number().greater(0).max(9999999999).precision(4).strict().required(),
        otherwise: Joi.valid(null).default(null),
    }),
    conversionUnit: Joi.when('unit', {
        is: Joi.valid('PACK', 'BOTTLE'),
        then: Joi.string()
            .valid(...Object.values(ConversionUnit))
            .required(),
        otherwise: Joi.valid(null).default(null),
    }),
    imageUrls: Joi.array()
        .items(
            Joi.string()
                .uri({ scheme: ['https'] })
                .max(2000)
        )
        .max(3)
        .unique()
        .default([]),
    recommendationReason: Joi.string().trim().min(1).max(500).required(),
})
    .oxor('manufacturerId', 'manufacturer')
    .unknown(false);
const material = Joi.object({
    operationType: Joi.string()
        .valid('FEEDING', 'MEDICINE', 'MINERAL', 'CHEMICAL', 'OTHER')
        .required(),
    firstDay: Joi.number().integer().min(1).max(3650),
    lastDay: Joi.number().integer().min(1).max(3650),
    applicationDays: Joi.array()
        .items(Joi.number().integer().min(1).max(3650))
        .min(1)
        .max(3650)
        .unique(),
    repeatIntervalDays: Joi.number().integer().min(1).max(30).default(1),
    productId: uuid,
    recommendation,
    doseBasis: Joi.string()
        .valid(...Object.values(DoseBasis))
        .required(),
    doseValue: Joi.number().greater(0).max(9999999999).precision(4).strict().required(),
    dailyDoseIncrement: Joi.number()
        .min(0)
        .max(9999999999)
        .precision(4)
        .strict()
        .default(0),
    doseUnit: Joi.string().valid('KG', 'G', 'L', 'ML', 'PCS').required(),
    instructions: Joi.string().trim().max(500).allow('', null).default(null),
})
    .xor('productId', 'recommendation')
    .unknown(false);

const createTemplate = {
    body: Joi.object({
        title: Joi.string().trim().min(1).max(500).required(),
        status: Joi.string()
            .valid(...Object.values(ProductionProtocolTemplateStatus))
            .default(ProductionProtocolTemplateStatus.active),
        farmId: uuid.required(),
        shrimpType: Joi.string()
            .valid(...Object.values(SHRIMP_TYPE))
            .required(),
        description: Joi.string().trim().max(255).allow('', null).default(null),
        allowedVariancePct: Joi.number()
            .min(0)
            .max(100)
            .precision(2)
            .default(10),
        referencePostCount: Joi.number()
            .integer()
            .min(1)
            .max(1000000000)
            .allow(null)
            .default(null),
        stages: Joi.array()
            .min(1)
            .max(120)
            .items(
                Joi.object({
                    startDay: Joi.number()
                        .integer()
                        .min(1)
                        .max(3650)
                        .required(),
                    endDay: Joi.number()
                        .integer()
                        .min(Joi.ref('startDay'))
                        .max(3650)
                        .required(),
                    meals: Joi.array()
                        .max(12)
                        .items(
                            Joi.object({
                                time: clock,
                                items: Joi.array()
                                    .min(1)
                                    .max(10)
                                    .items(material)
                                    .required(),
                            }).unknown(false)
                        )
                        .unique('time')
                        .default([]),
                    environment: Joi.array()
                        .max(20)
                        .items(
                            material.keys({
                                time: clock,
                                firstDay: Joi.number()
                                    .integer()
                                    .min(1)
                                    .max(3650)
                                    .required(),
                                repeatIntervalDays: Joi.number()
                                    .integer()
                                    .min(1)
                                    .max(30)
                                    .allow(null)
                                    .default(null),
                            })
                        )
                        .default([]),
                }).unknown(false)
            )
            .required(),
    })
        .unknown(false)
        .custom((body, helpers) => {
            for (const stage of body.stages) {
                const materials = [
                    ...stage.environment,
                    ...stage.meals.flatMap((meal) => meal.items),
                ];
                if (
                    materials.some(
                        (item) =>
                            (item.lastDay != null &&
                                (item.lastDay <
                                    (item.firstDay ?? stage.startDay) ||
                                    item.lastDay > stage.endDay)) ||
                            (item.applicationDays &&
                                item.applicationDays.some(
                                    (day, index) =>
                                        day < (item.firstDay ?? stage.startDay) ||
                                        day > (item.lastDay ?? stage.endDay) ||
                                        (index > 0 &&
                                            day <=
                                                item.applicationDays[index - 1])
                                ))
                    )
                )
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE
                            .INVALID_APPLICATION_DAYS,
                    });
                if (stage.environment.some((item) => item.applicationDays))
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE
                            .INVALID_APPLICATION_DAYS,
                    });
            }
            let previousEnd = 0;
            let itemCount = 0;
            for (const stage of body.stages) {
                if (
                    stage.startDay <= previousEnd ||
                    (!stage.meals.length && !stage.environment.length)
                ) {
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_STAGE,
                    });
                }
                if (
                    stage.environment.some(
                        (item) =>
                            item.firstDay < stage.startDay ||
                            item.firstDay > stage.endDay
                    )
                ) {
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE
                            .INVALID_ENVIRONMENT_START_DOC,
                    });
                }
                if (
                    stage.environment.some(
                        (item) =>
                            item.repeatIntervalDays != null &&
                            item.repeatIntervalDays >
                                (item.lastDay ?? stage.endDay) -
                                    item.firstDay +
                                    1
                    )
                ) {
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE
                            .INVALID_ENVIRONMENT_INTERVAL,
                    });
                }
                for (const meal of stage.meals) {
                    if (
                        meal.items.some(
                            (item) =>
                                item.firstDay != null &&
                                (item.firstDay < stage.startDay ||
                                    item.firstDay > stage.endDay)
                        )
                    ) {
                        return helpers.message({
                            custom: messages.EXPERT_PROTOCOL_TEMPLATE
                                .INVALID_MEAL_START_DOC,
                        });
                    }
                    const keys = meal.items.map(
                        (item) =>
                            item.productId ??
                            `proposal:${item.recommendation.name.toLowerCase()}`
                    );
                    if (new Set(keys).size !== keys.length)
                        return helpers.message({
                            custom: messages.EXPERT_PROTOCOL_TEMPLATE
                                .DUPLICATE_MEAL_MATERIAL,
                        });
                    itemCount += meal.items.length;
                }
                if (
                    stage.meals.some(
                        (meal, index) =>
                            index > 0 &&
                            meal.time <= stage.meals[index - 1].time
                    )
                ) {
                    return helpers.message({
                        custom: messages.EXPERT_PROTOCOL_TEMPLATE
                            .ORDERED_MEAL_TIMES,
                    });
                }
                itemCount += stage.environment.length;
                previousEnd = stage.endDay;
            }
            if (itemCount > 500)
                return helpers.message({
                    custom: messages.EXPERT_PROTOCOL_TEMPLATE.ITEM_LIMIT,
                });
            return body;
        }),
};
const creationOptions = { query: Joi.object({}).unknown(false) };
const getMaterials = {
    query: Joi.object({
        farmId: uuid.required(),
        search: Joi.string().trim().max(255).allow(''),
        group: Joi.string()
            .valid('ALL', 'FEED', 'MEDICINE', 'MINERAL', 'CHEMICAL', 'OTHER')
            .default('ALL'),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().valid(5, 10, 20).default(5),
    }).unknown(false),
};

const getTemplates = {
    query: Joi.object({
        search: Joi.string().trim().max(500).allow(''),
        status: Joi.string().valid(
            ...Object.values(ProductionProtocolTemplateStatus)
        ),
        farmId: Joi.string().uuid({ version: 'uuidv4' }),
        shrimpType: Joi.string()
            .uppercase()
            .valid(...Object.values(SHRIMP_TYPE)),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().valid(10, 20, 50).default(10),
    }).unknown(false),
};

const getTemplate = {
    params: Joi.object({
        templateId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }).unknown(false),
    query: Joi.object({}).unknown(false),
};

const updateTemplate = {
    params: getTemplate.params,
    query: getTemplate.query,
    body: createTemplate.body.keys({
        expectedVersionNo: Joi.number()
            .integer()
            .min(1)
            .max(2147483646)
            .required(),
    }),
};
const deleteTemplate = {
    params: getTemplate.params,
    query: getTemplate.query,
    body: Joi.object({
        expectedVersionNo: Joi.number()
            .integer()
            .min(1)
            .max(2147483646)
            .required(),
    }).unknown(false),
};
const updateStatus = {
    params: getTemplate.params,
    query: getTemplate.query,
    body: deleteTemplate.body.keys({
        status: Joi.string()
            .valid(...Object.values(ProductionProtocolTemplateStatus))
            .required(),
    }),
};
module.exports = {
    updateStatus,
    recommendation,
    getTemplates,
    getTemplate,
    createTemplate,
    creationOptions,
    getMaterials,
    updateTemplate,
    deleteTemplate,
};
