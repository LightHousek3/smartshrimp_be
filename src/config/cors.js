const config = require('./index');

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);

        // In development, allow all origins to simplify testing from local frontends
        // if (config.env !== 'production') return callback(null, true);

        if (config.cors.origin.includes(origin)) {
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
