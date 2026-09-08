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
 * Strict rate limiter for auth endpoints (login, register)
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: {
        success: false,
        statusCode: httpStatus.TOO_MANY_REQUESTS,
        message: 'Quá nhiều lần xác thực không thành công. Vui lòng thử lại sau 15 phút.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

module.exports = {
    apiLimiter,
    authLimiter,
};
