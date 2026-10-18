const Joi = require('joi');
const {
    fullNameField,
    passwordField,
    vietnamesePhoneField,
} = require('./accountFields.validator');

/**
 * Allow only editable identity fields and require at least one change.
 * Shared account validators keep phone normalization and name limits consistent with Auth.
 */
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

/**
 * Reuse Auth’s bcrypt byte limits; accept a non-empty existing password and a strong new one.
 * The required device UUID identifies the session renewed after revoking prior refresh tokens.
 */
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
