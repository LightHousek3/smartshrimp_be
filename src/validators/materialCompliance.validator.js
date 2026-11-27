const Joi = require('joi');
const registrationNumber = (requiredMessage) => Joi.string().trim().max(100).required().messages({
    'any.required': requiredMessage,
    'string.empty': requiredMessage,
    'string.max': 'Mã tiếp nhận/số ĐKLH tối đa 100 ký tự',
});

// One contract covers material facts; the service records the declaring account and time.
const productCompliance = Joi.object({
    regulatoryType: Joi.string()
        .valid(
            'feed',
            'environment',
            'dual_purpose',
            'medicine'
        )
        .required()
        .messages({
            'any.required': 'Chọn phân loại pháp lý theo hồ sơ vật tư.',
            'any.only': 'Chọn phân loại pháp lý theo hồ sơ vật tư.',
            'string.empty': 'Chọn phân loại pháp lý theo hồ sơ vật tư.',
            'string.base': 'Chọn phân loại pháp lý theo hồ sơ vật tư.',
        }),
    registrationNumber: Joi.when('regulatoryType', {
        switch: [
            { is: Joi.valid('medicine').required(), then: registrationNumber('Vui lòng nhập số đăng ký lưu hành thuốc thú y') },
            { is: Joi.valid('feed', 'environment', 'dual_purpose').required(), then: registrationNumber('Vui lòng nhập mã số tiếp nhận') },
        ],
        otherwise: Joi.string().trim().allow('', null),
    }),
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
