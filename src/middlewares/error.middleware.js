const logger = require('../config/logger');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

/**
 * Convert non-ApiError to ApiError
 */
const errorConverter = (err, req, res, next) => {
    let error = err;

    if (!(error instanceof ApiError)) {
        const connectionUnavailable = ['P1001', 'P1002', 'P1017', 'P2024', 'P2037'].includes(error.code)
            || /EMAXCONNSESSION|remaining connection slots|max clients reached/i.test(error.message || '');
        const statusCode = connectionUnavailable
            ? httpStatus.SERVICE_UNAVAILABLE
            : error.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
        const message = error.message || messages.SERVER.INTERNAL_ERROR;
        error = new ApiError(statusCode, message, false, err.stack);
    }

    next(error);
};

/**
 * Global error handler
 */
const errorHandler = (err, req, res, next) => {
    let { statusCode, message } = err;

    // Client messages remain safe and localized; diagnostic details belong in logs.
    if (!err.isOperational) {
        message =
            statusCode === httpStatus.BAD_REQUEST
                ? messages.COMMON.BAD_REQUEST
                : statusCode === httpStatus.SERVICE_UNAVAILABLE
                  ? messages.SERVER.SERVICE_UNAVAILABLE
                  : messages.SERVER.INTERNAL_ERROR;
    }

    // Log error
    if (statusCode >= 500) {
        logger.error(
            `${statusCode} - ${message} - ${req.originalUrl} - ${req.method} - ${req.ip}`,
            {
                stack: err.stack,
            },
        );
    } else {
        logger.warn(`${statusCode} - ${message} - ${req.originalUrl} - ${req.method}`);
    }

    const response = {
        success: false,
        statusCode,
        message,
        ...(err.isOperational && err.errorCode && { errorCode: err.errorCode }),
    };

    res.status(statusCode).json(response);
};

/**
 * Handle 404 - Route not found
 */
const notFoundHandler = (req, res, next) => {
    next(ApiError.notFound());
};

module.exports = {
    errorConverter,
    errorHandler,
    notFoundHandler,
};
