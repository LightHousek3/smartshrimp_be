const config = require('./index');

const LOCAL_DEVELOPMENT_ORIGIN =
    /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        const isLocalDevelopmentOrigin =
            config.env === 'development' && LOCAL_DEVELOPMENT_ORIGIN.test(origin);

        if (config.cors.origin.includes(origin) || isLocalDevelopmentOrigin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'X-Requested-With',
        'X-Device-Id',
    ],
    exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
    maxAge: 86400, // 24 hours
};

module.exports = corsOptions;
