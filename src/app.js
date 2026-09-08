const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const hpp = require('hpp');
const path = require('path');

const config = require('./config');
const corsOptions = require('./config/cors');
const logger = require('./config/logger');
const { apiLimiter, errorConverter, errorHandler, notFoundHandler } = require('./middlewares');
const routesV1 = require('./routes');
const { swaggerUi, swaggerSpec } = require('./docs/swagger');

const app = express();

// ═══════════════════════════════════════════════
// Security Middlewares
// ═══════════════════════════════════════════════

// Set security HTTP headers
app.set('trust proxy', 1);
app.use(helmet());

// CORS
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Rate limiting
if (config.env === 'production') {
    app.use('/api', apiLimiter);
}

// ═══════════════════════════════════════════════
// Body Parsing & Sanitization
// ═══════════════════════════════════════════════

// Parse JSON body (limit payload size)
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Parse cookies
app.use(cookieParser());

// Prevent HTTP parameter pollution
app.use(hpp());

// Compress responses
app.use(compression());

// ═══════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════

if (config.env !== 'test') {
    app.use(
        morgan('combined', {
            stream: { write: (message) => logger.info(message.trim()) },
        }),
    );
}

// ═══════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        environment: config.env,
    });
});

// ═══════════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════════

app.use(config.apiPrefix, routesV1);

// Swagger docs
app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
        explorer: true,
        swaggerOptions: {
            defaultModelsExpandDepth: -1,
        },
    }),
);
app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

// ═══════════════════════════════════════════════
// Error Handling
// ═══════════════════════════════════════════════

// Handle 404
app.use(notFoundHandler);

// Convert errors to ApiError
app.use(errorConverter);

// Global error handler
app.use(errorHandler);

module.exports = app;
