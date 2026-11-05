const ApiError = require('./ApiError');
const { ACCOUNT_ROLE, ACCOUNT_STATUS, VERIFICATION_PURPOSE, messages } = require('../constants');

const VERIFICATION_ROLES = Object.freeze([
    ACCOUNT_ROLE.FARM_OWNER, ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT,
]);

const createAuthError = (key, statusCode = 400) => Object.assign(
    new ApiError(statusCode, messages.AUTH[key]), { errorCode: `AUTH_${key}` },
);

// Call only after password/OTP/action-token proof has been validated.
const accountStateError = (account, purpose) => {
    if (account.status === ACCOUNT_STATUS.BLOCKED) return createAuthError('ACCOUNT_BLOCKED', 403);
    if (account.status === ACCOUNT_STATUS.INACTIVE) return createAuthError('ACCOUNT_INACTIVE', 403);
    if (purpose === VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION) {
        if (account.status !== ACCOUNT_STATUS.PENDING_ACTIVATION
            || account.activatedAt !== null || account.passwordHash !== null) {
            return createAuthError('ACCOUNT_ALREADY_ACTIVATED', 403);
        }
    } else if (account.status === ACCOUNT_STATUS.PENDING_ACTIVATION) {
        return createAuthError('PENDING_ACTIVATION', 403);
    } else if (account.status !== ACCOUNT_STATUS.ACTIVE
        || !account.activatedAt || !account.passwordHash) {
        return createAuthError('FORBIDDEN', 403);
    }
    return null;
};

module.exports = { VERIFICATION_ROLES, createAuthError, accountStateError };
