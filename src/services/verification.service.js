const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config');
const logger = require('../config/logger');
const emailService = require('./email.service');
const tokenService = require('./token.service');
const { emitNotification } = require('../realtime/notification.socket');
const { ACCOUNT_STATUS, VERIFICATION_PURPOSE, NOTIFICATION_TYPE } = require('../constants');
const { VERIFICATION_ROLES, createAuthError, accountStateError } = require('../utils/authPolicy');
const authTransaction = require('../utils/authTransaction');

const MAX_FAILED_ATTEMPTS = 5;
const activeChallengeWhere = (accountId, purpose) => ({
    accountId, purpose, consumedAt: null, supersededAt: null,
});
const hash = (value, pepper) => crypto.createHmac('sha256', pepper).update(value).digest('hex');
const hashOtp = (code) => hash(code, config.email.otpPepper);
const hashActionToken = (token) => hash(token, config.email.actionTokenPepper);
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);
const matchesHash = (left, right) => {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// State eligibility deliberately belongs to verify/complete, after ownership proof.
const requestOtp = async (email, purpose) => {
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const delivery = await authTransaction(async (transaction) => {
        const account = await transaction.account.findUnique({ where: { email } });
        if (!account || !VERIFICATION_ROLES.includes(account.role)) return null;
        const now = new Date();
        const where = activeChallengeWhere(account.id, purpose);
        const current = await transaction.emailVerificationChallenge.findFirst({ where });
        if (current?.resendAvailableAt > now) return null;
        await transaction.emailVerificationChallenge.updateMany({ where, data: { supersededAt: now } });
        const challenge = await transaction.emailVerificationChallenge.create({
            data: {
                accountId: account.id, purpose, codeHash: hashOtp(code), createdAt: now,
                expiresAt: addMinutes(now, config.email.verificationExpiresMinutes),
                resendAvailableAt: new Date(now.getTime() + config.email.resendDelaySeconds * 1000),
            },
        });
        return { account, challenge };
    }).catch((error) => {
        if (error.errorCode === 'AUTH_VERIFICATION_CONFLICT') return null;
        throw error;
    });
    if (!delivery) return;
    try {
        await emailService.sendOtp({ email, role: delivery.account.role, code, purpose });
    } catch (_) {
        // Public delivery failures must not reveal whether the account exists.
        logger.error('OTP email delivery failed', { challengeId: delivery.challenge.id });
        try {
            await prisma.emailVerificationChallenge.updateMany({
                where: { id: delivery.challenge.id, consumedAt: null, supersededAt: null },
                data: { supersededAt: new Date() },
            });
        } catch (_) {
            logger.error('OTP delivery cleanup failed', { challengeId: delivery.challenge.id });
        }
    }
};

const verifyOtp = async (email, code, purpose) => {
    const outcome = await authTransaction(async (transaction) => {
        const account = await transaction.account.findUnique({ where: { email } });
        if (!account || !VERIFICATION_ROLES.includes(account.role)) {
            return { error: createAuthError('INVALID_OTP') };
        }
        const now = new Date();
        const challenge = await transaction.emailVerificationChallenge.findFirst({
            where: activeChallengeWhere(account.id, purpose),
        });
        if (!challenge || challenge.verifiedAt) return { error: createAuthError('INVALID_OTP') };
        const invalidate = () => transaction.emailVerificationChallenge.updateMany({
            where: { id: challenge.id, consumedAt: null, supersededAt: null },
            data: { supersededAt: now },
        });
        if (challenge.expiresAt <= now) {
            await invalidate();
            return { error: createAuthError('OTP_EXPIRED') };
        }
        if (challenge.failedAttempts >= MAX_FAILED_ATTEMPTS) {
            await invalidate();
            return { error: createAuthError('OTP_ATTEMPTS_EXCEEDED') };
        }
        if (!matchesHash(challenge.codeHash, hashOtp(code))) {
            const attempts = challenge.failedAttempts + 1;
            await transaction.emailVerificationChallenge.updateMany({
                where: { id: challenge.id, verifiedAt: null, supersededAt: null, consumedAt: null },
                data: {
                    failedAttempts: { increment: 1 },
                    ...(attempts >= MAX_FAILED_ATTEMPTS ? { supersededAt: now } : {}),
                },
            });
            // Return instead of throwing so failed attempts are committed.
            return { error: createAuthError(attempts >= MAX_FAILED_ATTEMPTS
                ? 'OTP_ATTEMPTS_EXCEEDED' : 'INVALID_OTP') };
        }
        const stateError = accountStateError(account, purpose);
        if (stateError) {
            await invalidate();
            return { error: stateError };
        }
        const actionToken = crypto.randomBytes(32).toString('base64url');
        const result = await transaction.emailVerificationChallenge.updateMany({
            where: {
                id: challenge.id, verifiedAt: null, consumedAt: null, supersededAt: null,
                expiresAt: { gt: now }, failedAttempts: { lt: MAX_FAILED_ATTEMPTS },
            },
            data: {
                verifiedAt: now, actionTokenHash: hashActionToken(actionToken),
                actionTokenExpiresAt: addMinutes(now, config.email.actionTokenExpiresMinutes),
            },
        });
        return result.count === 1 ? { actionToken } : { error: createAuthError('INVALID_OTP') };
    });
    if (outcome.error) throw outcome.error;
    return outcome.actionToken;
};

const findActionChallenge = async (database, actionToken, purpose) => {
    const challenge = await database.emailVerificationChallenge.findUnique({
        where: { actionTokenHash: hashActionToken(actionToken) }, include: { account: true },
    });
    if (!challenge || challenge.purpose !== purpose || !challenge.verifiedAt
        || challenge.consumedAt || challenge.supersededAt || !challenge.actionTokenExpiresAt
        || challenge.actionTokenExpiresAt <= new Date()
        || !VERIFICATION_ROLES.includes(challenge.account.role)) {
        throw createAuthError('INVALID_ACTION_TOKEN');
    }
    return challenge;
};

const completeVerification = async (purpose, { actionToken, password, fullName, phone }) => {
    // Reject invalid tokens before spending bcrypt work; recheck after hashing in the transaction.
    await findActionChallenge(prisma, actionToken, purpose);
    const passwordHash = await bcrypt.hash(password, config.security.bcryptSaltRounds);
    const outcome = await authTransaction(async (transaction) => {
        const challenge = await findActionChallenge(transaction, actionToken, purpose);
        const { account } = challenge;
        const now = new Date();
        const stateError = accountStateError(account, purpose);
        if (stateError) {
            await transaction.emailVerificationChallenge.updateMany({
                where: { id: challenge.id, consumedAt: null, supersededAt: null },
                data: { supersededAt: now },
            });
            return { error: stateError };
        }
        const consumed = await transaction.emailVerificationChallenge.updateMany({
            where: {
                id: challenge.id, verifiedAt: { not: null }, consumedAt: null, supersededAt: null,
                actionTokenExpiresAt: { gt: now },
            },
            data: { consumedAt: now },
        });
        if (consumed.count !== 1) throw createAuthError('INVALID_ACTION_TOKEN');
        const activation = purpose === VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION;
        const updated = await transaction.account.updateMany({
            where: {
                id: account.id, role: account.role,
                status: activation ? ACCOUNT_STATUS.PENDING_ACTIVATION : ACCOUNT_STATUS.ACTIVE,
                passwordHash: account.passwordHash, activatedAt: account.activatedAt,
            },
            data: activation
                ? { fullName, phone: phone ?? null, passwordHash, status: ACCOUNT_STATUS.ACTIVE, activatedAt: now }
                : { passwordHash },
        });
        if (updated.count !== 1) throw createAuthError('VERIFICATION_CONFLICT', 409);
        await transaction.emailVerificationChallenge.updateMany({
            where: { accountId: account.id, consumedAt: null, supersededAt: null },
            data: { supersededAt: now },
        });
        await tokenService.revokeAllAccountTokens(account.id, transaction);
        let notification;
        if (activation && account.managedByOwnerId) {
            notification = await transaction.notification.create({
                data: {
                    accountId: account.managedByOwnerId, title: 'Nhân sự đã kích hoạt tài khoản',
                    content: `${fullName} đã kích hoạt tài khoản và có thể được phân công vào vụ nuôi.`,
                    type: NOTIFICATION_TYPE.MANAGED_ACCOUNT_ACTIVATED,
                    referenceType: 'account', referenceId: account.id,
                }, select: { id: true },
            });
        }
        return { notification, ownerId: account.managedByOwnerId };
    });
    if (outcome.error) throw outcome.error;
    if (outcome.notification) {
        emitNotification(outcome.ownerId, 'notification:new', { id: outcome.notification.id });
    }
};

module.exports = {
    requestOtp, verifyOtp,
    activateAccount: (input) => completeVerification(VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION, input),
    resetPassword: (input) => completeVerification(VERIFICATION_PURPOSE.PASSWORD_RESET, input),
};
