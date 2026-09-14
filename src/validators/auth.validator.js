const Joi = require('joi');

const passwordSchema = (minimumLength) =>
    Joi.string()
        .min(minimumLength)
        .max(72)
        .custom((value, helpers) => {
            if (Buffer.byteLength(value, 'utf8') > 72) {
                return helpers.error('string.maxBytes');
            }
            return value;
        })
        .messages({ 'string.maxBytes': '"password" must not exceed 72 bytes' });

const email = Joi.string().trim().lowercase().email().max(320).required();

const actionToken = Joi.string()
    .trim()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .min(32)
    .max(128)
    .required();

const newPassword = passwordSchema(6).required();

const login = {
    body: Joi.object().keys({
        email,
        password: passwordSchema(1).required(),
        deviceId: Joi.string().uuid({ version: 'uuidv4' }),
    }),
};

const requestOtp = {
    body: Joi.object().keys({ email }),
};

const verifyOtp = {
    body: Joi.object().keys({
        email,
        code: Joi.string()
            .pattern(/^\d{6}$/)
            .required(),
    }),
};

const activateAccount = {
    body: Joi.object().keys({
        actionToken,
        fullName: Joi.string().trim().min(1).max(255).required(),
        phone: Joi.string()
            .trim()
            .pattern(/^\+?[0-9]{8,15}$/)
            .required(),
        password: newPassword,
    }),
};

const resetPassword = {
    body: Joi.object().keys({
        actionToken,
        password: newPassword,
    }),
};

const tokenBody = {
    body: Joi.object().keys({
        refreshToken: Joi.string().trim().max(4096),
    }),
};

module.exports = {
    login,
    logout: tokenBody,
    refreshTokens: tokenBody,
    requestOtp,
    verifyOtp,
    activateAccount,
    resetPassword,
};
