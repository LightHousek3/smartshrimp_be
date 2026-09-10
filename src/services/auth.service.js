const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS } = require('../constants');
const tokenService = require('./token.service');

const LOGIN_USER_SELECT = {
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

const withoutPassword = ({ passwordHash, ...user }) => user;

/**
 * Login with email and password.
 * Password validity is checked before account status so an attacker cannot use
 * this endpoint to discover the status of an account without its password.
 */
const login = async (email, password, deviceId) => {
    const user = await prisma.user.findUnique({
        where: { email },
        select: LOGIN_USER_SELECT,
    });

    const passwordMatches = user?.passwordHash
        ? await bcrypt.compare(password, user.passwordHash)
        : false;

    if (!user || !passwordMatches) {
        throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_CREDENTIALS);
    }

    if (user.status !== ACCOUNT_STATUS.ACTIVE) {
        throw new ApiError(
            httpStatus.FORBIDDEN,
            ACCOUNT_STATUS_ERRORS[user.status] || messages.AUTH.UNAUTHORIZED,
        );
    }

    const loginAt = new Date();
    const resolvedDeviceId = deviceId || crypto.randomUUID();

    const tokens = await prisma.$transaction(async (transaction) => {
        // The status predicate protects token issuance from a concurrent status change.
        const updateResult = await transaction.user.updateMany({
            where: { id: user.id, status: ACCOUNT_STATUS.ACTIVE },
            data: { lastLoginAt: loginAt },
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.FORBIDDEN, messages.AUTH.ACCOUNT_INACTIVE);
        }

        return tokenService.generateAuthTokens(user, resolvedDeviceId, transaction);
    });

    return {
        user: withoutPassword({ ...user, lastLoginAt: loginAt }),
        tokens,
    };
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
