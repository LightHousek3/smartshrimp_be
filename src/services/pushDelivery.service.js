const prisma = require('../config/prisma');
const logger = require('../config/logger');
const messaging = require('./firebaseMessaging.service');
const policy = require('../utils/pushNotificationPolicy');
const limits = require('../constants/pushNotification');
const { localizeNotification } = require('../utils');
const { cleared } = require('./pushDevice.service');
const { presentNotifications } = require('./notification.service');

/**
 * Select due push notifications with attempts remaining, including processing leases eligible for
 * reclaim.
 */
const ready = (now) => ({
    pushStatus: { in: ['pending', 'processing'] },
    pushAttempts: { lt: limits.maxAttempts },
    pushNextAttemptAt: { lte: now },
});
/**
 * Limit push text by Unicode code points so truncation preserves surrogate pairs.
 */
const short = (text, size) =>
    Array.from(text ?? '')
        .slice(0, size)
        .join('');

/** Keep the same notification identity across retries; the provider accepting it is not a read receipt. */
const message = (storedNotification, tokens, expiry, now) => {
    const notification = localizeNotification(storedNotification);
    return {
        fids: tokens,
        notification: {
            title: short(notification.title, 100),
            body: short(notification.content || 'Bạn có thông báo mới trên SmartShrimp.', 240),
        },
        data: {
            notificationId: notification.id,
            accountId: notification.accountId,
            expiresAt: expiry.toISOString(),
        },
        android: {
            priority: 'high',
            ttl: Math.max(1000, expiry - now),
            notification: {
                channelId: limits.channelId,
                icon: 'ic_stat_smartshrimp',
                tag: notification.id,
                sound: 'default',
            },
        },
        apns: {
            headers: {
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'apns-expiration': String(Math.floor(expiry.getTime() / 1000)),
                'apns-collapse-id': notification.id,
            },
            payload: { aps: { sound: 'default', threadId: 'smartshrimp' } },
        },
    };
};

/** Claim with a lease and attempt fence so an abandoned sender cannot overwrite its successor. */
const processNotification = async (row, now = new Date()) => {
    const attempt = row.pushAttempts + 1;
    // The attempt counter is the fence; PostgreSQL timestamps retain finer precision than JS dates.
    const claimed = await prisma.notification.updateMany({
        where: { id: row.id, ...ready(now), pushAttempts: row.pushAttempts },
        data: {
            pushStatus: 'processing',
            pushAttempts: attempt,
            pushNextAttemptAt: new Date(now.getTime() + limits.leaseMs),
        },
    });
    if (!claimed.count) return false;
    const fence = { id: row.id, pushStatus: 'processing', pushAttempts: attempt };
    const finish = (status, next = null) =>
        prisma.notification.updateMany({
            where: fence,
            data: { pushStatus: status, pushNextAttemptAt: next },
        });
    try {
        const notification = await prisma.notification.findUnique({ where: { id: row.id } });
        if (!notification) return false;
        const expiry = await policy.expiresAt(prisma, notification, now);
        if (!expiry) {
            await finish('skipped');
            return true;
        }
        const sessions = await prisma.refreshToken.findMany({
            where: {
                accountId: notification.accountId,
                revokedAt: null,
                expiresAt: { gt: now },
                pushToken: { not: null },
                account: {
                    status: 'ACTIVE',
                    OR: [{ managedByOwnerId: null }, { managedByOwner: { status: 'ACTIVE' } }],
                },
            },
            select: { id: true, pushToken: true, pushTokenUpdatedAt: true },
        });
        const tokens = [...new Set(sessions.map((session) => session.pushToken))];
        if (!tokens.length) {
            await finish('skipped');
            return true;
        }
        const [presented] = await presentNotifications([notification], notification.accountId);
        let accepted = 0,
            retryable = false,
            permanent = false;
        for (let start = 0; start < tokens.length; start += 500) {
            // A slow or abandoned sender must not continue after another worker takes its lease.
            const sendingAt = new Date();
            if (
                sendingAt >= expiry ||
                !(await prisma.notification.count({
                    where: { ...fence, pushNextAttemptAt: { gt: sendingAt } },
                }))
            )
                return false;
            const batch = tokens.slice(start, start + 500);
            const result = await messaging.send(message(presented, batch, expiry, now));
            for (const [index, response] of result.responses.entries()) {
                if (response.success) {
                    accepted++;
                    continue;
                }
                const code = response.error?.code ?? 'messaging/unknown-error';
                if (policy.invalidToken(code)) {
                    // An old provider response must not clear a newer device registration.
                    await prisma.refreshToken.updateMany({
                        where: {
                            pushToken: batch[index],
                            OR: sessions
                                .filter((session) => session.pushToken === batch[index])
                                .map(({ id, pushTokenUpdatedAt }) => ({ id, pushTokenUpdatedAt })),
                        },
                        data: cleared,
                    });
                } else {
                    retryable ||= policy.transient(code);
                    permanent ||= !policy.transient(code);
                    logger.warn(`Push ${notification.id} attempt ${attempt} rejected (${code}).`);
                }
            }
        }
        if (retryable && attempt < limits.maxAttempts)
            await finish('pending', policy.retryAt(now, attempt));
        else await finish(permanent || retryable ? 'failed' : accepted ? 'sent' : 'skipped');
        return true;
    } catch (error) {
        const code = typeof error.code === 'string' ? error.code : 'messaging/unknown-error';
        // Never log provider errors: they can contain endpoint tokens or credential details.
        logger.warn(`Push ${row.id} attempt ${attempt} failed (${short(code, 100)}).`);
        if (attempt < limits.maxAttempts && policy.transient(code))
            await finish('pending', policy.retryAt(now, attempt));
        else await finish('failed');
        return false;
    }
};

/** Read only fresh queue entries; a restart never replays the existing inbox. */
const processPending = async ({ now = new Date(), isRunning = () => true } = {}) => {
    if (!messaging.configured()) return { processed: 0, failed: 0 };
    await prisma.notification.updateMany({
        where: {
            pushStatus: 'processing',
            pushAttempts: { gte: limits.maxAttempts },
            pushNextAttemptAt: { lte: now },
        },
        data: { pushStatus: 'failed', pushNextAttemptAt: null },
    });
    const rows = await prisma.notification.findMany({
        where: ready(now),
        orderBy: [{ pushNextAttemptAt: 'asc' }, { id: 'asc' }],
        take: limits.batchSize,
        select: { id: true, pushAttempts: true, pushNextAttemptAt: true },
    });
    let processed = 0,
        failed = 0;
    for (const row of rows) {
        if (!isRunning()) break;
        if (await processNotification(row, new Date())) processed++;
        else failed++;
    }
    return { processed, failed };
};

module.exports = { processPending, processNotification, message };
