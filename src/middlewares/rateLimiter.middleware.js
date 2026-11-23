const rateLimit = require('express-rate-limit');
const config = require('../config');
const { httpStatus, messages } = require('../constants');
const RedisRateLimitStore = require('./redisRateLimitStore');

/** Keep each quota independent and preserve Express's local store when Redis is disabled. */
const createLimiter = (name, options) => {
    const defaults = { standardHeaders: true, legacyHeaders: false };
    if (!config.redis?.rateLimitUrl) return rateLimit({ ...defaults, ...options });

    const store = new RedisRateLimitStore(`${config.redis.keyPrefix}:rate:v1:${name}:`, name === 'api');
    const { skipSuccessfulRequests, ...limits } = options;
    const limiter = rateLimit({ ...defaults, ...limits, store });
    if (!skipSuccessfulRequests) return limiter;

    return (req, res, next) => limiter(req, res, (error) => {
        if (error) return next(error);
        const { resetTime } = req.rateLimit;
        const key = req.ip;
        res.once('finish', () => {
            if (res.statusCode < 400) void store.decrement(key, resetTime);
        });
        return next();
    });
};

/**
 * General API rate limiter
 */
const apiLimiter = createLimiter('api', {
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.SERVER.TOO_MANY_REQUESTS,
    },
});

/**
 * Strict rate limiter for auth endpoints
 */
const authLimiter = createLimiter('auth', {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: 'Quá nhiều lần thao tác không thành công. Vui lòng thử lại sau 15 phút.',
    },
    skipSuccessfulRequests: true,
});

/**
 * Count successful requests too: both public OTP purposes share this IP quota.
 */
const otpRequestLimiter = createLimiter('otp-request', {
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.SERVER.TOO_MANY_REQUESTS,
    },
});

// Share one IP quota across document writes, including cancellation and metadata edits.
const writeLimiter = createLimiter('write', {
    windowMs: config.rateLimit.writeWindowMs,
    max: config.rateLimit.writeMax,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.SERVER.TOO_MANY_REQUESTS,
    },
});

const inventoryLabelLimiter = createLimiter('inventory-label', {
    windowMs: 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.account.id,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.INVENTORY_LABEL.RATE_LIMIT,
    },
});

module.exports = {
    createLimiter,
    inventoryLabelLimiter,
    apiLimiter,
    authLimiter,
    otpRequestLimiter,
    writeLimiter,
};
