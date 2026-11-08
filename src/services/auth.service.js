const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS } = require('../constants');
const tokenService = require('./token.service');
const authTransaction = require('../utils/authTransaction');
const { createAuthError } = require('../utils/authPolicy');

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
    [ACCOUNT_STATUS.PENDING_ACTIVATION]: messages.AUTH.PENDING_ACTIVATION,
    [ACCOUNT_STATUS.BLOCKED]: messages.AUTH.ACCOUNT_BLOCKED,
    [ACCOUNT_STATUS.INACTIVE]: messages.AUTH.ACCOUNT_INACTIVE,
};

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
        const key = account.status === ACCOUNT_STATUS.PENDING_ACTIVATION
            ? 'PENDING_ACTIVATION' : `ACCOUNT_${account.status}`;
        throw createAuthError(ACCOUNT_STATUS_ERRORS[account.status] ? key : 'FORBIDDEN', 403);
    }

    const loginAt = new Date();
    const resolvedDeviceId = deviceId || crypto.randomUUID();

    const result = await authTransaction(async (transaction) => {
        const current = await transaction.account.findUnique({
            where: { id: account.id }, select: LOGIN_ACCOUNT_SELECT,
        });
        if (!current || current.passwordHash !== account.passwordHash) {
            throw createAuthError('INVALID_CREDENTIALS', 401);
        }
        if (current.status !== ACCOUNT_STATUS.ACTIVE) {
            const key = current.status === ACCOUNT_STATUS.PENDING_ACTIVATION
                ? 'PENDING_ACTIVATION' : `ACCOUNT_${current.status}`;
            throw createAuthError(ACCOUNT_STATUS_ERRORS[current.status] ? key : 'FORBIDDEN', 403);
        }
        const updated = await transaction.account.updateMany({
            where: { id: account.id, status: ACCOUNT_STATUS.ACTIVE, passwordHash: account.passwordHash },
            data: { lastLoginAt: loginAt },
        });
        if (updated.count !== 1) throw createAuthError('VERIFICATION_CONFLICT', 409);
        const tokens = await tokenService.generateAuthTokens(current, resolvedDeviceId, transaction);
        return { account: withoutPassword({ ...current, lastLoginAt: loginAt }), tokens };
    });
    return result;
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
