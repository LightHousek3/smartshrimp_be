const prisma = require('../config/prisma');
const config = require('../config');
const ApiError = require('../utils/ApiError');
const transaction = require('../utils/jobTransaction');
const { messages } = require('../constants/pushNotification');

const cleared = { pushToken: null, pushPlatform: null, pushTokenUpdatedAt: null };

/** Bind an endpoint to a live server-issued session and detach its previous account binding. */
const register = async (accountId, { deviceId, token, platform }) => {
    if (!config.firebase?.projectId) throw new ApiError(503, messages.UNAVAILABLE);
    await transaction(async (tx) => {
        const now = new Date();
        const session = await tx.refreshToken.findFirst({
            where: { accountId, deviceId, revokedAt: null, expiresAt: { gt: now } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true },
        });
        if (!session) throw ApiError.unauthorized(messages.SESSION_REQUIRED);
        await tx.refreshToken.updateMany({
            where: { pushToken: { not: null }, OR: [{ pushToken: token }, { deviceId }] },
            data: cleared,
        });
        const changed = await tx.refreshToken.updateMany({
            where: { id: session.id, accountId, deviceId, revokedAt: null, expiresAt: { gt: now } },
            data: { pushToken: token, pushPlatform: platform, pushTokenUpdatedAt: now },
        });
        if (changed.count !== 1) throw ApiError.conflict(messages.CONFLICT);
    });
};

/** Repeated cleanup is account-scoped and cannot detach another account's session. */
const unregister = (accountId, deviceId) =>
    prisma.refreshToken.updateMany({
        where: { accountId, deviceId, pushToken: { not: null } },
        data: cleared,
    });

module.exports = { register, unregister, cleared };
