const bcrypt = require('bcryptjs');
const crypto = require('crypto');
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

const withoutPassword = ({ passwordHash, ...account }) => account;

/**
 * Login with email and password.
 * Password validity is checked before account status so an attacker cannot use
 * this endpoint to discover the status of an account without its password.
 */
const login = async (email, password) => {
    const account = await prisma.account.findUnique({
        where: { email },
        select: LOGIN_ACCOUNT_SELECT,
    });

    const passwordMatches = account?.passwordHash
        ? await bcrypt.compare(password, account.passwordHash)
        : false;

    if (!account || !passwordMatches) {
        throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.LOGIN_ERRORS.INVALID_CREDENTIALS);
    }

    if (account.status !== ACCOUNT_STATUS.ACTIVE) {
        const key = ACCOUNT_STATUS_ERRORS[account.status] || 'FORBIDDEN';
        throw Object.assign(new ApiError(httpStatus.FORBIDDEN, messages.AUTH.LOGIN_ERRORS[key]), {
            errorCode: `AUTH_${key}`,
        });
    }

    const loginAt = new Date();
    const deviceId = crypto.randomUUID();

    return prisma.$transaction(async (transaction) => {
        await transaction.account.update({
            where: { id: account.id },
            data: { lastLoginAt: loginAt },
        });
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

const refreshTokens = async (refreshToken) => tokenService.refreshAuthTokens(refreshToken);

module.exports = {
    login,
    logout,
    refreshTokens,
};
