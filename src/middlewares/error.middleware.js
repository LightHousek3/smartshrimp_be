const config = require('../config');
const logger = require('../config/logger');
const { ApiError } = require('../utils');
const { httpStatus } = require('../constants');

/**
 * Convert non-ApiError to ApiError
 */
const errorConverter = (err, req, res, next) => {
    let error = err;

    if (!(error instanceof ApiError)) {
        const statusCode = error.statusCode || httpStatus.INTERNAL_SERVER_ERROR;
        const message = error.message || 'Internal Server Error';
        error = new ApiError(statusCode, message, false, err.stack);
    }

    next(error);
};

/**
 * Global error handler
 */
const errorHandler = (err, req, res, next) => {
    let { statusCode, message } = err;

    // In production, hide internal error details
    if (config.env === 'production' && !err.isOperational) {
        statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        message = 'Internal Server Error';
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
        ...(config.env === 'development' && { stack: err.stack }),
    };

    res.status(statusCode).json(response);
};

/**
 * Handle 404 - Route not found
 */
const notFoundHandler = (req, res, next) => {
    next(new ApiError(httpStatus.NOT_FOUND, `Route ${req.originalUrl} not found`));
};

module.exports = {
    errorConverter,
    errorHandler,
    notFoundHandler,
};
