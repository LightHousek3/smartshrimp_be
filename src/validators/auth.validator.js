const Joi = require('joi');

const password = Joi.string()
    .min(1)
    .max(72)
    .custom((value, helpers) => {
        if (Buffer.byteLength(value, 'utf8') > 72) {
            return helpers.error('string.maxBytes');
        }
        return value;
    })
    .messages({ 'string.maxBytes': '"password" must not exceed 72 bytes' });

const login = {
    body: Joi.object().keys({
        email: Joi.string().trim().lowercase().email().max(320).required(),
        password: password.required(),
        deviceId: Joi.string().uuid({ version: 'uuidv4' }),
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
};
