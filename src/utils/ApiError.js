const messages = require('../constants/messages');

/**
 * Custom API Error class for operational errors
 * @extends Error
 */
class ApiError extends Error {
    /**
     * @param {number} statusCode - HTTP status code
     * @param {string} message - Error message
     * @param {boolean} [isOperational=true] - Whether error is operational
     * @param {string} [stack=''] - Error stack trace
     */
    constructor(statusCode, message, isOperational = true, stack = '') {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';

        if (stack) {
            this.stack = stack;
        } else {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Create a 400 Bad Request error
     */
    static badRequest(message = messages.COMMON.BAD_REQUEST) {
        return new ApiError(400, message);
    }

    /**
     * Create a 401 Unauthorized error
     */
    static unauthorized(message = messages.AUTH.UNAUTHORIZED) {
        return new ApiError(401, message);
    }

    /**
     * Create a 403 Forbidden error
     */
    static forbidden(message = messages.AUTH.FORBIDDEN) {
        return new ApiError(403, message);
    }

    /**
     * Create a 404 Not Found error
     */
    static notFound(message = messages.COMMON.NOT_FOUND) {
        return new ApiError(404, message);
    }

    /**
     * Create a 409 Conflict error
     */
    static conflict(message = messages.COMMON.CONFLICT) {
        return new ApiError(409, message);
    }

    /**
     * Create a 500 Internal Server Error
     */
    static internal(message = messages.SERVER.INTERNAL_ERROR) {
        return new ApiError(500, message, false);
    }
}

module.exports = ApiError;
