const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS } = require('../constants');
const tokenService = require('./token.service');

const LOGIN_ACCOUNT_SELECT = {
    id: true,
    email: true,
    phone: true,
    passwordHash: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    activatedAt: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
};

const ACCOUNT_STATUS_ERRORS = {
    [ACCOUNT_STATUS.PENDING_ACTIVATION]: 'PENDING_ACTIVATION',
    [ACCOUNT_STATUS.BLOCKED]: 'ACCOUNT_BLOCKED',
    [ACCOUNT_STATUS.INACTIVE]: 'ACCOUNT_INACTIVE',
};

/**
 * Remove the password hash before the authenticated account leaves the service.
 */
const withoutPassword = ({ passwordHash, ...account }) => account;

/**
 * Login with email and password.
 * Password validity is checked before account status so an attacker cannot use
 * this endpoint to discover the status of an account without its password.
 */
const login = async (email, password, deviceId) => {
    const account = await prisma.account.findUnique({
        where: { email },
        select: LOGIN_ACCOUNT_SELECT,
    });

    const passwordMatches = account?.passwordHash
        ? await bcrypt.compare(password, account.passwordHash)
        : false;

    if (!account || !passwordMatches) {
        throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_CREDENTIALS);
    }

    if (account.status !== ACCOUNT_STATUS.ACTIVE) {
        const key = ACCOUNT_STATUS_ERRORS[account.status] || 'FORBIDDEN';
        throw Object.assign(new ApiError(httpStatus.FORBIDDEN, messages.AUTH[key]), {
            errorCode: `AUTH_${key}`,
        });
    }

    const loginAt = new Date();

    return prisma.$transaction(async (transaction) => {
        // Serialize same-account logins and reject credentials changed during password verification.
        const updated = await transaction.account.updateMany({
            where: {
                id: account.id,
                passwordHash: account.passwordHash,
                status: ACCOUNT_STATUS.ACTIVE,
            },
            data: { lastLoginAt: loginAt },
        });
        if (updated.count !== 1) {
            throw ApiError.conflict(messages.AUTH.LOGIN_CONFLICT);
        }
        const tokens = await tokenService.generateAuthTokens(account, deviceId, transaction);
        return { account: withoutPassword({ ...account, lastLoginAt: loginAt }), tokens };
    });
};

/**
 * Logout is deliberately idempotent: unknown/already revoked tokens are treated
 * as logged out, while a matching active token is revoked.
 */
const logout = async (refreshToken) => {
    if (refreshToken) {
        await tokenService.revokeRefreshToken(refreshToken);
    }
};

/**
 * Use the token service's rotation flow for both cookie and request-body credentials.
 */
const refreshTokens = async (refreshToken) => tokenService.refreshAuthTokens(refreshToken);

module.exports = {
    login,
    logout,
    refreshTokens,
};
