const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config');
const logger = require('../config/logger');
const emailService = require('./email.service');
const tokenService = require('./token.service');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    USER_ROLE,
    ACCOUNT_STATUS,
    VERIFICATION_PURPOSE,
} = require('../constants');

const ELIGIBLE_ROLES = [USER_ROLE.FARM_OWNER, USER_ROLE.TECHNICIAN, USER_ROLE.EXPERT];
const MAX_FAILED_ATTEMPTS = 5;

/**
 * Add minutes to a date.
 */
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);

/**
 * Add seconds to a date.
 */
const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);

/**
 * Hash a value with the configured HMAC pepper.
 */
const hashWithPepper = (value, pepper) =>
    crypto.createHmac('sha256', pepper).update(value).digest('hex');

/**
 * Hash an OTP before storing or comparing it.
 */
const hashOtp = (code) => hashWithPepper(code, config.email.otpPepper);

/**
 * Hash an action token before storing or comparing it.
 */
const hashActionToken = (token) => hashWithPepper(token, config.email.actionTokenPepper);

/**
 * Compare two hexadecimal hashes in constant time.
 */
const isSameHash = (leftHash, rightHash) => {
    const left = Buffer.from(leftHash, 'hex');
    const right = Buffer.from(rightHash, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Check whether a user can use the requested verification flow.
 */
const isEligibleUser = (user, purpose) => {
    if (!user || !ELIGIBLE_ROLES.includes(user.role)) {
        return false;
    }

    if (purpose === VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION) {
        return (
            user.status === ACCOUNT_STATUS.PENDING_ACTIVATION &&
            user.activatedAt === null &&
            user.passwordHash === null
        );
    }

    return user.activatedAt !== null && user.passwordHash !== null;
};

/**
 * Load the user fields required by the verification flows.
 */
const findVerificationUser = (email) =>
    prisma.user.findUnique({
        where: { email },
        select: {
            id: true,
            email: true,
            role: true,
            status: true,
            activatedAt: true,
            passwordHash: true,
        },
    });

/**
 * Create a new OTP challenge and deliver it by email. Unknown/ineligible email
 * addresses return the same success result to prevent account enumeration.
 */
const requestOtp = async (email, purpose) => {
    const user = await findVerificationUser(email);
    if (!isEligibleUser(user, purpose)) {
        return;
    }

    const now = new Date();
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    let challenge;
    try {
        challenge = await prisma.$transaction(
            async (transaction) => {
                const currentChallenge =
                    await transaction.emailVerificationChallenge.findFirst({
                        where: {
                            userId: user.id,
                            purpose,
                            consumedAt: null,
                            supersededAt: null,
                        },
                        orderBy: { createdAt: 'desc' },
                    });

                if (currentChallenge && currentChallenge.resendAvailableAt > now) {
                    throw new ApiError(
                        httpStatus.TOO_MANY_REQUESTS,
                        messages.AUTH.RESEND_TOO_SOON,
                    );
                }

                await transaction.emailVerificationChallenge.updateMany({
                    where: {
                        userId: user.id,
                        purpose,
                        consumedAt: null,
                        supersededAt: null,
                    },
                    data: { supersededAt: now },
                });

                return transaction.emailVerificationChallenge.create({
                    data: {
                        userId: user.id,
                        purpose,
                        codeHash: hashOtp(code),
                        expiresAt: addMinutes(now, config.email.verificationExpiresMinutes),
                        resendAvailableAt: addSeconds(now, config.email.resendDelaySeconds),
                    },
                });
            },
            { isolationLevel: 'Serializable' },
        );
    } catch (error) {
        if (error.code === 'P2002' || error.code === 'P2034') {
            throw new ApiError(httpStatus.TOO_MANY_REQUESTS, messages.AUTH.RESEND_TOO_SOON);
        }
        throw error;
    }

    try {
        await emailService.sendOtp({ email: user.email, code, purpose });
    } catch (error) {
        // Do not leave an unusable challenge blocking the next delivery attempt.
        await prisma.emailVerificationChallenge
            .updateMany({
                where: { id: challenge.id, consumedAt: null, supersededAt: null },
                data: { supersededAt: new Date() },
            })
            .catch((cleanupError) => {
                logger.error('Failed to invalidate OTP challenge after email delivery error', {
                    challengeId: challenge.id,
                    error: cleanupError.message,
                });
            });
        throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.AUTH.EMAIL_DELIVERY_FAILED);
    }
};

/**
 * Verify an OTP and exchange it for a short-lived, single-use action token.
 */
const verifyOtp = async (email, code, purpose) => {
    const user = await findVerificationUser(email);
    if (!isEligibleUser(user, purpose)) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_OTP);
    }

    const now = new Date();
    const outcome = await prisma.$transaction(
        async (transaction) => {
            const challenge = await transaction.emailVerificationChallenge.findFirst({
                where: {
                    userId: user.id,
                    purpose,
                    consumedAt: null,
                    supersededAt: null,
                },
                orderBy: { createdAt: 'desc' },
            });

            if (!challenge || challenge.verifiedAt) {
                return { error: new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_OTP) };
            }

            if (challenge.expiresAt <= now) {
                await transaction.emailVerificationChallenge.update({
                    where: { id: challenge.id },
                    data: { supersededAt: now },
                });
                return { error: new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.OTP_EXPIRED) };
            }

            if (challenge.failedAttempts >= MAX_FAILED_ATTEMPTS) {
                await transaction.emailVerificationChallenge.update({
                    where: { id: challenge.id },
                    data: { supersededAt: now },
                });
                return {
                    error: new ApiError(
                        httpStatus.BAD_REQUEST,
                        messages.AUTH.OTP_ATTEMPTS_EXCEEDED,
                    ),
                };
            }

            const codeMatches = isSameHash(challenge.codeHash, hashOtp(code));
            if (!codeMatches) {
                const failedAttempts = challenge.failedAttempts + 1;
                await transaction.emailVerificationChallenge.update({
                    where: { id: challenge.id },
                    data: {
                        failedAttempts,
                        ...(failedAttempts >= MAX_FAILED_ATTEMPTS ? { supersededAt: now } : {}),
                    },
                });

                const message =
                    failedAttempts >= MAX_FAILED_ATTEMPTS
                        ? messages.AUTH.OTP_ATTEMPTS_EXCEEDED
                        : messages.AUTH.INVALID_OTP;
                return { error: new ApiError(httpStatus.BAD_REQUEST, message) };
            }

            const actionToken = crypto.randomBytes(32).toString('base64url');
            const updateResult = await transaction.emailVerificationChallenge.updateMany({
                where: {
                    id: challenge.id,
                    verifiedAt: null,
                    consumedAt: null,
                    supersededAt: null,
                    expiresAt: { gt: now },
                    failedAttempts: { lt: MAX_FAILED_ATTEMPTS },
                },
                data: {
                    verifiedAt: now,
                    actionTokenHash: hashActionToken(actionToken),
                    actionTokenExpiresAt: addMinutes(
                        now,
                        config.email.actionTokenExpiresMinutes,
                    ),
                },
            });

            if (updateResult.count !== 1) {
                return { error: new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_OTP) };
            }

            return { actionToken };
        },
        { isolationLevel: 'Serializable' },
    );

    if (outcome.error) {
        throw outcome.error;
    }

    return outcome.actionToken;
};

/**
 * Find and validate the single-use action challenge for a flow.
 */
const findActionChallenge = (actionToken, purpose) =>
    prisma.emailVerificationChallenge.findUnique({
        where: { actionTokenHash: hashActionToken(actionToken) },
        include: { user: true },
    }).then((challenge) => {
        const now = new Date();
        if (
            !challenge ||
            challenge.purpose !== purpose ||
            !challenge.verifiedAt ||
            challenge.consumedAt ||
            challenge.supersededAt ||
            !challenge.actionTokenExpiresAt ||
            challenge.actionTokenExpiresAt <= now
        ) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_ACTION_TOKEN);
        }

        return challenge;
    });

/**
 * Atomically consume an action challenge inside the current transaction.
 */
const consumeActionChallenge = async (transaction, challengeId, now) => {
    const result = await transaction.emailVerificationChallenge.updateMany({
        where: {
            id: challengeId,
            verifiedAt: { not: null },
            consumedAt: null,
            supersededAt: null,
            actionTokenExpiresAt: { gt: now },
        },
        data: { consumedAt: now },
    });

    if (result.count !== 1) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_ACTION_TOKEN);
    }
};

/**
 * Complete activation with the verified action token and new account details.
 */
const activateAccount = async ({ actionToken, fullName, phone, password }) => {
    const challenge = await findActionChallenge(
        actionToken,
        VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION,
    );
    if (!isEligibleUser(challenge.user, VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION)) {
        throw new ApiError(httpStatus.CONFLICT, messages.AUTH.ACCOUNT_ALREADY_ACTIVATED);
    }

    const passwordHash = await bcrypt.hash(password, config.security.bcryptSaltRounds);
    const now = new Date();

    await prisma.$transaction(async (transaction) => {
        await consumeActionChallenge(transaction, challenge.id, now);
        const updateResult = await transaction.user.updateMany({
            where: {
                id: challenge.userId,
                role: { in: ELIGIBLE_ROLES },
                status: ACCOUNT_STATUS.PENDING_ACTIVATION,
                activatedAt: null,
                passwordHash: null,
            },
            data: {
                fullName,
                phone,
                passwordHash,
                status: ACCOUNT_STATUS.ACTIVE,
                activatedAt: now,
            },
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.CONFLICT, messages.AUTH.ACCOUNT_ALREADY_ACTIVATED);
        }
    });
};

/**
 * Replace the password and revoke existing sessions after token verification.
 */
const resetPassword = async ({ actionToken, password }) => {
    const challenge = await findActionChallenge(
        actionToken,
        VERIFICATION_PURPOSE.PASSWORD_RESET,
    );
    if (!isEligibleUser(challenge.user, VERIFICATION_PURPOSE.PASSWORD_RESET)) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_ACTION_TOKEN);
    }

    const passwordHash = await bcrypt.hash(password, config.security.bcryptSaltRounds);
    const now = new Date();

    await prisma.$transaction(async (transaction) => {
        await consumeActionChallenge(transaction, challenge.id, now);
        const updateResult = await transaction.user.updateMany({
            where: {
                id: challenge.userId,
                role: { in: ELIGIBLE_ROLES },
                activatedAt: { not: null },
                passwordHash: { not: null },
            },
            data: { passwordHash },
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.AUTH.INVALID_ACTION_TOKEN);
        }

        await tokenService.revokeAllUserTokens(challenge.userId, transaction);
    });
};

module.exports = {
    requestOtp,
    verifyOtp,
    activateAccount,
    resetPassword,
};
