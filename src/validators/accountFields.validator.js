const Joi = require('joi');

const ACCOUNT_FIELD_RULES = Object.freeze({
    emailMaxLength: 254,
    fullNameMinLength: 2,
    fullNameMaxLength: 50,
    passwordMinLength: 6,
    passwordMaxBytes: 72,
});

const FULL_NAME_PATTERN = /^\p{L}[\p{L}\p{M}]*\.?(?: \p{L}[\p{L}\p{M}]*\.?)*$/u;
const VIETNAMESE_MOBILE_PATTERN = /^0(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])\d{7}$/;

/**
 * Count Unicode code points so surrogate pairs do not count as two characters.
 */
const characterCount = (value) => Array.from(value).length;

/**
 * Normalize names to NFC and collapse whitespace before validation and persistence.
 */
const normalizeFullName = (value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

/**
 * Convert international +84 mobile numbers to the domestic form used for storage.
 */
const normalizeVietnamesePhone = (value) => {
    const compact = value.trim().replace(/[\s.()-]/g, '');
    return compact.startsWith('+84') ? `0${compact.slice(3)}` : compact;
};

/**
 * Report a custom field error through Joi so it follows the standard validation flow.
 */
const validationError = (helpers, message) => helpers.message({ 'any.custom': message });

/**
 * Build the shared ASCII email field with normalized casing and the account storage limit.
 */
const emailField = () =>
    Joi.string()
        .trim()
        .lowercase()
        .email({ tlds: { allow: false }, allowUnicode: false })
        .max(ACCOUNT_FIELD_RULES.emailMaxLength)
        .label('Email')
        .messages({ 'string.email': 'Email không hợp lệ.' })
        .required();

/**
 * Validate the normalized name's character count and allowed characters before saving it.
 */
const fullNameField = ({ required = false } = {}) => {
    let schema = Joi.string().custom((value, helpers) => {
        const normalized = normalizeFullName(value);
        const length = characterCount(normalized);

        if (length < ACCOUNT_FIELD_RULES.fullNameMinLength) {
            return validationError(
                helpers,
                `Họ và tên phải có ít nhất ${ACCOUNT_FIELD_RULES.fullNameMinLength} ký tự`,
            );
        }
        if (length > ACCOUNT_FIELD_RULES.fullNameMaxLength) {
            return validationError(
                helpers,
                `Họ và tên không được vượt quá ${ACCOUNT_FIELD_RULES.fullNameMaxLength} ký tự`,
            );
        }
        if (!FULL_NAME_PATTERN.test(normalized)) {
            return validationError(
                helpers,
                'Họ và tên chỉ được chứa chữ cái, khoảng trắng và dấu chấm cuối từ.',
            );
        }
        return normalized;
    });

    schema = schema.label('Họ và tên');
    if (required) schema = schema.required();
    return schema;
};

/**
 * Validate a domestic-format Vietnamese mobile number after normalization and honor the caller's
 * nullability rules.
 */
const vietnamesePhoneField = ({ required = false, allowNull = false } = {}) => {
    let schema = Joi.string().custom((value, helpers) => {
        const normalized = normalizeVietnamesePhone(value);
        if (!VIETNAMESE_MOBILE_PATTERN.test(normalized)) {
            return validationError(helpers, 'Số điện thoại không đúng định dạng Việt Nam');
        }
        return normalized;
    });

    schema = schema.label('Số điện thoại');
    if (allowNull) schema = schema.allow(null);
    if (required) schema = schema.required();
    return schema;
};

/**
 * Enforce the action's minimum character count and bcrypt's UTF-8 byte limit without altering the
 * credential.
 */
const passwordField = ({ minimumLength = ACCOUNT_FIELD_RULES.passwordMinLength } = {}) =>
    Joi.string()
        .label('Mật khẩu')
        .custom((value, helpers) => {
            if (characterCount(value) < minimumLength) {
                return validationError(helpers, `Mật khẩu phải có ít nhất ${minimumLength} ký tự`);
            }
            if (Buffer.byteLength(value, 'utf8') > ACCOUNT_FIELD_RULES.passwordMaxBytes) {
                return validationError(
                    helpers,
                    `Mật khẩu quá dài. Vui lòng sử dụng mật khẩu ngắn hơn.`,
                );
            }
            return value;
        })
        .required();

/**
 * Classify password strength from length and character groups for profile feedback.
 */
const getPasswordStrength = (password) => {
    if (characterCount(password) < ACCOUNT_FIELD_RULES.passwordMinLength) return 'TOO_SHORT';

    const characterGroups = [
        /[a-z]/.test(password),
        /[A-Z]/.test(password),
        /\d/.test(password),
        /[^A-Za-z0-9]/.test(password),
    ].filter(Boolean).length;

    if (characterCount(password) >= 12 && characterGroups === 4) return 'STRONG';
    if (characterCount(password) >= 8 && characterGroups >= 3) return 'FAIRLY_STRONG';
    return 'MEDIUM';
};

module.exports = {
    emailField,
    ACCOUNT_FIELD_RULES,
    FULL_NAME_PATTERN,
    VIETNAMESE_MOBILE_PATTERN,
    normalizeFullName,
    normalizeVietnamesePhone,
    fullNameField,
    vietnamesePhoneField,
    passwordField,
    getPasswordStrength,
};
