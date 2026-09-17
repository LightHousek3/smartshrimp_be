const Joi = require('joi');
const {
    fullNameField,
    passwordField,
    vietnamesePhoneField,
} = require('./accountFields.validator');

const updateProfile = {
    body: Joi.object()
        .keys({
            fullName: fullNameField(),
            phone: vietnamesePhoneField({ allowNull: true }),
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
        currentPassword: passwordField({ minimumLength: 1 }),
        newPassword: passwordField(),
        deviceId: Joi.string().uuid({ version: 'uuidv4' }).required(),
    }),
};

module.exports = {
    updateProfile,
    changePassword,
};
