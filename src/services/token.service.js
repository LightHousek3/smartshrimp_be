const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS } = require('../constants');

const PUBLIC_USER_SELECT = {
    id: true,
    email: true,
    phone: true,
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

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const generateAccessToken = (user) => {
    const payload = {
        sub: user.id,
        role: user.role,
        type: 'access',
    };

    return jwt.sign(payload, config.jwt.accessSecret, {
        expiresIn: config.jwt.accessExpiration,
    });
};

/**
 * Generate and persist a refresh token. Passing a transaction client lets the
 * caller make token creation atomic with other account updates.
 */
const generateRefreshToken = async (user, deviceId, database = prisma) => {
    const payload = {
        sub: user.id,
        type: 'refresh',
        deviceId,
        jti: crypto.randomUUID(),
    };
    const token = jwt.sign(payload, config.jwt.refreshSecret, {
        expiresIn: config.jwt.refreshExpiration,
    });
    const decoded = jwt.decode(token);
    const now = new Date();

    // One active session per user/device; old rows are retained for traceability.
    await database.refreshToken.updateMany({
        where: {
            userId: user.id,
            deviceId,
            revokedAt: null,
        },
        data: { revokedAt: now },
    });

    await database.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash: hashToken(token),
            deviceId,
            expiresAt: new Date(decoded.exp * 1000),
        },
    });

    return token;
};

const generateAuthTokens = async (user, deviceId, database = prisma) => {
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user, deviceId, database);
    return { accessToken, refreshToken };
};

const refreshAuthTokens = async (refreshToken) => {
    if (!refreshToken) {
        throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_REFRESH_TOKEN);
    }

    let decoded;
    try {
        decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
            throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_REFRESH_TOKEN);
        }
        throw error;
    }

    if (decoded.type !== 'refresh' || !decoded.sub || !decoded.deviceId) {
        throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_REFRESH_TOKEN);
    }

    const tokenHash = hashToken(refreshToken);
    const now = new Date();

    return prisma.$transaction(async (transaction) => {
        const storedToken = await transaction.refreshToken.findUnique({
            where: { tokenHash },
        });

        if (
            !storedToken ||
            storedToken.userId !== decoded.sub ||
            storedToken.deviceId !== decoded.deviceId ||
            storedToken.revokedAt ||
            storedToken.expiresAt <= now
        ) {
            throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_REFRESH_TOKEN);
        }

        const user = await transaction.user.findUnique({
            where: { id: decoded.sub },
            select: PUBLIC_USER_SELECT,
        });

        if (!user || user.status !== ACCOUNT_STATUS.ACTIVE) {
            throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.UNAUTHORIZED);
        }

        const revokeResult = await transaction.refreshToken.updateMany({
            where: { id: storedToken.id, revokedAt: null, expiresAt: { gt: now } },
            data: { revokedAt: now },
        });

        if (revokeResult.count !== 1) {
            throw new ApiError(httpStatus.UNAUTHORIZED, messages.AUTH.INVALID_REFRESH_TOKEN);
        }

        const tokens = await generateAuthTokens(user, storedToken.deviceId, transaction);
        return { ...tokens, user };
    });
};

const revokeRefreshToken = async (refreshToken) => {
    await prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
    });
};

const revokeAllUserTokens = async (userId) => {
    await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
};

module.exports = {
    generateAccessToken,
    generateRefreshToken,
    generateAuthTokens,
    refreshAuthTokens,
    revokeRefreshToken,
    revokeAllUserTokens,
    hashToken,
};
