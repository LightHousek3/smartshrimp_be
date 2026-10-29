const Joi = require('joi');

// One contract covers material profiles and proposals; the service owns reviewer identity and timestamps.
const productCompliance = Joi.object({
    regulatoryType: Joi.string()
        .valid(
            'unclassified',
            'feed',
            'environment',
            'dual_purpose',
            'medicine'
        )
        .default('unclassified'),
    registrationNumber: Joi.string().trim().max(100).empty('').allow(null).default(null),
    ingredientsText: Joi.string()
        .trim()
        .max(20000)
        .allow('', null)
        .default(null),
    containsAntibiotic: Joi.boolean().strict().allow(null).default(null),
    usageInstructions: Joi.string()
        .trim()
        .max(20000)
        .allow('', null)
        .default(null),
    withdrawalDays: Joi.number()
        .min(0)
        .max(9999.999)
        .precision(3)
        .allow(null)
        .default(null),
    evidenceUrls: Joi.array()
        .items(
            Joi.string()
                .uri({ scheme: ['https'] })
                .max(2000)
        )
        .max(6)
        .unique()
        .default([]),
    complianceStatus: Joi.string().valid('draft', 'reviewed').default('draft'),
    reviewNote: Joi.string().trim().max(20000).allow('', null).default(null),
}).unknown(false);

const manufacturer = Joi.object({
    name: Joi.string().trim().replace(/\s+/gu, ' ').min(1).max(255).required(),
    supplierType: Joi.string()
        .valid('manufacturer', 'both')
        .default('manufacturer'),
    contactName: Joi.string().trim().max(255).allow('', null).default(null),
    phone: Joi.string().trim().max(20).allow('', null).default(null),
    email: Joi.string().trim().email().max(320).allow('', null).default(null),
    address: Joi.string().trim().max(1000).allow('', null).default(null),
    note: Joi.string().trim().max(2000).allow('', null).default(null),
}).unknown(false);
module.exports = { productCompliance, manufacturer };
