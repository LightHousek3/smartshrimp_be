const jwt = require('jsonwebtoken');
const config = require('../config');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages, ACCOUNT_STATUS } = require('../constants');

const AUTHENTICATED_ACCOUNT_SELECT = {
    id: true,
    email: true,
    phone: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    activatedAt: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
};

/**
 * Extract the access token from an HTTP Bearer authorization header.
 * @param {string} authorization - Authorization header value
 * @returns {string|null} Token, or null when the Bearer credential is missing
 */
const getBearerToken = (authorization) => {
    const [scheme, token] = (authorization || '').split(' ');
    return scheme === 'Bearer' && token ? token : null;
};

/**
 * Verify an access token and load its active account for HTTP and notification sockets.
 * Reject non-access tokens, missing accounts, and blocked or inactive accounts.
 *
 * @param {string} token - Signed JWT access token
 * @returns {Promise<Object>} Active account without password credentials
 * @throws {Error} JWT verification error or account access error
 */
const loadActiveAccount = async (token) => {
    const decoded = jwt.verify(token, config.jwt.accessSecret);
    if (decoded.type !== 'access' || !decoded.sub) {
        throw new jwt.JsonWebTokenError('Invalid access token');
    }

    const account = await prisma.account.findUnique({
        where: { id: decoded.sub },
        select: AUTHENTICATED_ACCOUNT_SELECT,
    });

    if (!account) {
        throw ApiError.unauthorized(messages.AUTH.UNAUTHORIZED);
    }

    if (account.status === ACCOUNT_STATUS.BLOCKED) {
        throw ApiError.forbidden(messages.AUTH.ACCOUNT_BLOCKED);
    }

    if (account.status !== ACCOUNT_STATUS.ACTIVE) {
        throw ApiError.forbidden(messages.AUTH.ACCOUNT_INACTIVE);
    }

    return account;
};

/**
 * Require a valid Bearer access token and attach the active account to req.account.
 * Notification controllers use this verified account to enforce recipient ownership.
 * Forward expired or invalid JWTs as unauthorized errors to the error middleware.
 */
const authenticate = async (req, res, next) => {
    try {
        const token = getBearerToken(req.headers.authorization);
        if (!token) {
            throw ApiError.unauthorized(messages.AUTH.UNAUTHORIZED);
        }

        req.account = await loadActiveAccount(token);
        next();
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            return next(ApiError.unauthorized('Access token expired'));
        }

        if (error instanceof jwt.JsonWebTokenError) {
            return next(ApiError.unauthorized(messages.AUTH.UNAUTHORIZED));
        }

        return next(error);
    }
};

/**
 * Build middleware restricting an authenticated account to the allowed roles.
 * Must run after authenticate, which populates req.account.
 *
 * @param {...string} roles - Account roles allowed to access the route
 * @returns {Function} Express authorization middleware
 */
const authorize = (...roles) => (req, res, next) => {
    if (!req.account) {
        return next(ApiError.unauthorized(messages.AUTH.UNAUTHORIZED));
    }

    if (!roles.includes(req.account.role)) {
        return next(ApiError.forbidden(messages.AUTH.FORBIDDEN));
    }

    return next();
};

const optionalAuth = async (req, res, next) => {
    try {
        const token = getBearerToken(req.headers.authorization);
        if (token) {
            req.account = await loadActiveAccount(token);
        }
    } catch (error) {
        // Optional authentication intentionally ignores invalid credentials.
    }

    next();
};

module.exports = {
    authenticate,
    authorize,
    optionalAuth,
    loadActiveAccount,
};
