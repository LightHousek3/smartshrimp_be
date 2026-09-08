/**
 * Standardized API response handler.
 * Ensures all API responses follow the same format.
 */
class ResponseHandler {
    /**
     * Success response
     * @param {Object} res - Express response object
     * @param {Object} options
     * @param {number} [options.statusCode=200] - HTTP status code
     * @param {string} [options.message='Success'] - Response message
     * @param {*} [options.data=null] - Response data
     * @param {Object} [options.meta=null] - Pagination/extra metadata
     */
    static success(res, { statusCode = 200, message = 'Success', data = null, meta = null } = {}) {
        const response = {
            success: true,
            message,
            ...(data !== null && { data }),
            ...(meta !== null && { meta }),
        };
        return res.status(statusCode).json(response);
    }

    /**
     * Created response (201)
     */
    static created(res, { message = 'Created successfully', data = null } = {}) {
        return ResponseHandler.success(res, { statusCode: 201, message, data });
    }

    /**
     * No content response (204)
     */
    static noContent(res) {
        return res.status(204).send();
    }

    /**
     * Paginated response
     * @param {Object} res - Express response object
     * @param {Object} options
     * @param {Array} options.data - Array of results
     * @param {number} options.page - Current page
     * @param {number} options.limit - Items per page
     * @param {number} options.totalResults - Total number of results
     */
    static paginated(res, { data, meta, message = 'Success' }) {
        return res.status(200).json({
            success: true,
            message,
            data,
            meta,
        });
    }

    /**
     * Error response
     */
    static error(res, { statusCode = 500, message = 'Internal Server Error', errors = null } = {}) {
        const response = {
            success: false,
            message,
            ...(errors && { errors }),
        };
        return res.status(statusCode).json(response);
    }
}

module.exports = ResponseHandler;
