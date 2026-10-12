const rateLimit = require('express-rate-limit');
const config = require('../config');
const { httpStatus, messages } = require('../constants');

/**
 * General API rate limiter
 */
const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.SERVER.TOO_MANY_REQUESTS,
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Strict rate limiter for auth endpoints
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: 'Quá nhiều lần thao tác không thành công. Vui lòng thử lại sau 15 phút.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

// Share one IP quota across document writes, including cancellation and metadata edits.
const writeLimiter = rateLimit({
    windowMs: config.rateLimit.writeWindowMs,
    max: config.rateLimit.writeMax,
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: messages.SERVER.TOO_MANY_REQUESTS,
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    apiLimiter,
    authLimiter,
    writeLimiter,
};
