const Joi = require('joi');

const ACCOUNT_FIELD_RULES = Object.freeze({
    fullNameMinLength: 2,
    fullNameMaxLength: 50,
    passwordMinLength: 6,
    passwordMaxBytes: 72,
});

const FULL_NAME_PATTERN = /^\p{L}[\p{L}\p{M}]*\.?(?: \p{L}[\p{L}\p{M}]*\.?)*$/u;
const VIETNAMESE_MOBILE_PATTERN = /^0(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])\d{7}$/;

const characterCount = (value) => Array.from(value).length;

const normalizeFullName = (value) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

const normalizeVietnamesePhone = (value) => {
    const compact = value.trim().replace(/[\s.()-]/g, '');
    return compact.startsWith('+84') ? `0${compact.slice(3)}` : compact;
};

const validationError = (helpers, message) => helpers.message({ 'any.custom': message });

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

    if (required) schema = schema.required();
    return schema;
};

const vietnamesePhoneField = ({ required = false, allowNull = false } = {}) => {
    let schema = Joi.string().custom((value, helpers) => {
        const normalized = normalizeVietnamesePhone(value);
        if (!VIETNAMESE_MOBILE_PATTERN.test(normalized)) {
            return validationError(helpers, 'Số điện thoại không đúng định dạng Việt Nam');
        }
        return normalized;
    });

    if (allowNull) schema = schema.allow(null);
    if (required) schema = schema.required();
    return schema;
};

const passwordField = ({ minimumLength = ACCOUNT_FIELD_RULES.passwordMinLength } = {}) =>
    Joi.string()
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
