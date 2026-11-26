const Joi = require('joi');

// One contract covers material facts; the service records the declaring account and time.
const productCompliance = Joi.object({
    regulatoryType: Joi.string()
        .valid(
            'feed',
            'environment',
            'dual_purpose',
            'medicine'
        )
        .required(),
    registrationNumber: Joi.string().trim().min(1).max(100).required(),
    ingredientsText: Joi.string()
        .trim()
        .max(20000)
        .min(1)
        .required(),
    containsAntibiotic: Joi.boolean().strict().required(),
    usageInstructions: Joi.string()
        .trim()
        .max(20000)
        .min(1)
        .required(),
    withdrawalDays: Joi.number()
        .min(0)
        .max(9999.999)
        .precision(3)
        .when('regulatoryType', { is: 'medicine', then: Joi.required(), otherwise: Joi.allow(null).default(null) }),
    evidenceUrls: Joi.array()
        .items(
            Joi.string()
                .uri({ scheme: ['https'] })
                .max(2000)
        )
        .max(6)
        .unique()
        .default([]),
    checkedBy: Joi.any().strip(),
    checkedAt: Joi.any().strip(),
}).unknown(false);

module.exports = { productCompliance };
