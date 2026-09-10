const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const API_PREFIX = `/${(process.env.API_PREFIX || '/api/v1').replace(/^\/+|\/+$/g, '')}`;

const config = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 3000,
    apiPrefix: API_PREFIX,
    app: {
        backendUrl: BASE_URL || undefined,
    },

    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '15m',
        refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
    },

    cookie: {
        refreshTokenName: process.env.REFRESH_TOKEN_COOKIE_NAME || 'refreshToken',
        domain: process.env.COOKIE_DOMAIN || undefined,
        secure:
            process.env.COOKIE_SECURE !== undefined
                ? process.env.COOKIE_SECURE === 'true'
                : process.env.NODE_ENV === 'production',
        sameSite:
            process.env.COOKIE_SAME_SITE ||
            (process.env.NODE_ENV === 'production' ? 'none' : 'lax'),
        refreshTokenMaxAgeMs:
            parseInt(process.env.REFRESH_TOKEN_COOKIE_MAX_AGE_MS, 10) || 7 * 24 * 60 * 60 * 1000,
    },

    cors: {
        origin: process.env.CORS_ORIGIN
            ? process.env.CORS_ORIGIN.split(',')
            : ['http://localhost:3000', 'http://localhost:5173'],
    },

    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
        max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    },

    log: {
        level: process.env.LOG_LEVEL || 'debug',
        dir: process.env.LOG_DIR || 'logs',
    },

    email: {
        smtp: {
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT, 10) || 587,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        },
        from: process.env.EMAIL_FROM || 'noreply@smartshrimp.vn',
        verificationExpiresMinutes:
            parseInt(process.env.EMAIL_VERIFICATION_EXPIRES_MINUTES, 10) || 10,
    },
};

module.exports = config;
