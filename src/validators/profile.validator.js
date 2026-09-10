const Joi = require('joi');

const passwordWithBcryptLimit = (minimumLength) =>
    Joi.string()
        .min(minimumLength)
        .max(72)
        .custom((value, helpers) => {
            if (Buffer.byteLength(value, 'utf8') > 72) {
                return helpers.error('string.maxBytes');
            }
            return value;
        })
        .messages({ 'string.maxBytes': 'Mật khẩu không được vượt quá 72 bytes' });

const updateProfile = {
    body: Joi.object()
        .keys({
            fullName: Joi.string().trim().min(1).max(255),
            phone: Joi.string()
                .trim()
                .pattern(/^(?:\+?[1-9]\d{7,14}|0\d{8,10})$/)
                .max(20)
                .allow(null),
            avatarUrl: Joi.string()
                .trim()
                .uri({ scheme: ['http', 'https'] })
                .max(2048)
                .allow(null),
        })
        .min(1),
};

const changePassword = {
    body: Joi.object().keys({
        currentPassword: passwordWithBcryptLimit(1).required(),
        newPassword: passwordWithBcryptLimit(6).required(),
    }),
};

module.exports = {
    updateProfile,
    changePassword,
};
