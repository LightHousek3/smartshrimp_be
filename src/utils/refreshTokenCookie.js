const config = require('../config');

/**
 * Build the shared cookie scope and security options for issuing and clearing the refresh credential.
 */
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

/**
 * Send the issued refresh token in the configured HTTP-only session cookie.
 */
const setRefreshTokenCookie = (res, token) => {
    res.cookie(config.cookie.refreshTokenName, token, getRefreshTokenCookieOptions());
};

/**
 * Expire the refresh cookie using the same scope and security flags that were used to issue it.
 */
const clearRefreshTokenCookie = (res) => {
    const options = getRefreshTokenCookieOptions();
    delete options.maxAge;
    res.clearCookie(config.cookie.refreshTokenName, options);
};

module.exports = {
    setRefreshTokenCookie,
    clearRefreshTokenCookie,
};
