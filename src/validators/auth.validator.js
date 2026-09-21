const Joi = require('joi');
const {
    fullNameField,
    passwordField,
    vietnamesePhoneField,
} = require('./accountFields.validator');

const email = Joi.string().trim().lowercase().email().max(320).required();

const actionToken = Joi.string()
    .trim()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .min(32)
    .max(128)
    .required();

const newPassword = passwordField();

const login = {
    body: Joi.object().keys({
        email,
        password: passwordField({ minimumLength: 1 }),
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
        fullName: fullNameField({ required: true }),
        phone: vietnamesePhoneField({ allowNull: true }),
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
