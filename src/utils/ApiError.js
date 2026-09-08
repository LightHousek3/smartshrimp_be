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
    static badRequest(message = 'Bad Request') {
        return new ApiError(400, message);
    }

    /**
     * Create a 401 Unauthorized error
     */
    static unauthorized(message = 'Unauthorized') {
        return new ApiError(401, message);
    }

    /**
     * Create a 403 Forbidden error
     */
    static forbidden(message = 'Forbidden') {
        return new ApiError(403, message);
    }

    /**
     * Create a 404 Not Found error
     */
    static notFound(message = 'Not Found') {
        return new ApiError(404, message);
    }

    /**
     * Create a 409 Conflict error
     */
    static conflict(message = 'Conflict') {
        return new ApiError(409, message);
    }

    /**
     * Create a 500 Internal Server Error
     */
    static internal(message = 'Internal Server Error') {
        return new ApiError(500, message, false);
    }
}

module.exports = ApiError;
