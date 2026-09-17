const config = require('../config');

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

const setRefreshTokenCookie = (res, token) => {
    res.cookie(config.cookie.refreshTokenName, token, getRefreshTokenCookieOptions());
};

const clearRefreshTokenCookie = (res) => {
    const options = getRefreshTokenCookieOptions();
    delete options.maxAge;
    res.clearCookie(config.cookie.refreshTokenName, options);
};

module.exports = {
    setRefreshTokenCookie,
    clearRefreshTokenCookie,
};
