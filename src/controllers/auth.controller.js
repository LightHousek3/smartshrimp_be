const { authService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');
const config = require('../config');

/**
 * POST /auth/login
 */
const login = asyncHandler(async (req, res) => {
    const { email, password, deviceId } = req.body;
    const { user, tokens } = await authService.login(email, password, deviceId);

    setRefreshTokenCookie(res, tokens.refreshToken);

    ResponseHandler.success(res, {
        message: messages.AUTH.LOGIN_SUCCESS,
        data: {
            user,
            tokens: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
            },
        },
    });
});

/**
 * POST /auth/logout
 */
const logout = asyncHandler(async (req, res) => {
    const refreshToken =
        req.body.refreshToken || req.cookies?.[config.cookie.refreshTokenName];

    // Always remove the client credential, even if token revocation later fails.
    clearRefreshTokenCookie(res);

    if (refreshToken) {
        await authService.logout(refreshToken);
    }

    ResponseHandler.success(res, {
        message: messages.AUTH.LOGOUT_SUCCESS,
    });
});

/**
 * POST /auth/refresh-token
 */
const refreshTokens = asyncHandler(async (req, res) => {
    const refreshToken =
        req.body.refreshToken || req.cookies?.[config.cookie.refreshTokenName];
    const {
        accessToken,
        refreshToken: newRefreshToken,
        user,
    } = await authService.refreshTokens(refreshToken);

    setRefreshTokenCookie(res, newRefreshToken);

    ResponseHandler.success(res, {
        message: messages.AUTH.TOKEN_REFRESHED,
        data: {
            user,
            accessToken,
            refreshToken: newRefreshToken,
        },
    });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set refresh token as httpOnly cookie
 */
const setRefreshTokenCookie = (res, token) => {
    res.cookie(config.cookie.refreshTokenName, token, getRefreshTokenCookieOptions());
};

/**
 * Clear refresh token cookie
 */
const clearRefreshTokenCookie = (res) => {
    const options = getRefreshTokenCookieOptions();
    delete options.maxAge;
    res.clearCookie(config.cookie.refreshTokenName, options);
};

const getRefreshTokenCookieOptions = (overrides = {}) => {
    const options = {
        httpOnly: true,
        secure: config.cookie.secure,
        sameSite: config.cookie.sameSite,
        maxAge: config.cookie.refreshTokenMaxAgeMs,
        path: '/',
        ...overrides,
    };

    if (config.cookie.domain) {
        options.domain = config.cookie.domain;
    }

    return options;
};

module.exports = {
    login,
    logout,
    refreshTokens,
};
