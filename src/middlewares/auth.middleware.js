const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../utils');
const { User } = require('../models');
const { httpStatus, messages, USER_STATUS } = require('../constants');

/**
 * Authenticate user via JWT Bearer token
 */
const authenticate = async (req, res, next) => {
    try {
        let token;

        // Extract token from Authorization header
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        }

        if (!token) {
            throw ApiError.unauthorized(messages.AUTH.UNAUTHORIZED);
        }

        // Verify token
        const decoded = jwt.verify(token, config.jwt.accessSecret);

        // Fetch user
        const user = await User.findById(decoded.sub).select('-password');
        if (!user) {
            throw ApiError.unauthorized(messages.AUTH.UNAUTHORIZED);
        }

        // Check user status
        if (user.status === USER_STATUS.BLOCKED) {
            throw ApiError.forbidden(messages.AUTH.ACCOUNT_BLOCKED);
        }

        if (user.status === USER_STATUS.INACTIVE) {
            throw ApiError.forbidden(messages.AUTH.ACCOUNT_INACTIVE);
        }

        // Attach user to request
        req.user = user;
        next();
    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) {
            return next(ApiError.unauthorized(messages.AUTH.UNAUTHORIZED));
        }
        if (error instanceof jwt.TokenExpiredError) {
            return next(ApiError.unauthorized('Access token expired'));
        }
        next(error);
    }
};

/**
 * Authorize by roles
 * @param  {...string} roles - Allowed roles (e.g., 'ADMIN', 'USER')
 */
const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return next(ApiError.unauthorized(messages.AUTH.UNAUTHORIZED));
        }

        if (!roles.includes(req.user.role)) {
            return next(ApiError.forbidden(messages.AUTH.FORBIDDEN));
        }

        next();
    };
};

/**
 * Optional authentication - attaches user if token is present, continues otherwise
 */
const optionalAuth = async (req, res, next) => {
    try {
        let token;
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
            token = req.headers.authorization.split(' ')[1];
        }

        if (token) {
            const decoded = jwt.verify(token, config.jwt.accessSecret);
            const user = await User.findById(decoded.sub).select('-password');
            if (user && user.status === USER_STATUS.ACTIVE) {
                req.user = user;
            }
        }
    } catch (error) {
        // Silently ignore auth errors for optional auth
    }
    next();
};

module.exports = {
    authenticate,
    authorize,
    optionalAuth,
};
