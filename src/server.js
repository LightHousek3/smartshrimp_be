const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const connectDB = require('./config/db');

let server;

const startServer = async () => {
    // Connect to Postgre
    await connectDB();

    server = app.listen(config.port, () => {
        logger.info(`
    ╔═══════════════════════════════════════════════════╗
    ║   Smart Shrimp                        ║
    ║   Environment: ${config.env.padEnd(24)}           ║
    ║   Port: ${String(config.port).padEnd(33)}         ║
    ║   API: ${config.apiPrefix.padEnd(30)}             ║
    ╚═══════════════════════════════════════════════════╝
    `);
    });
};

// ─── Handle unhandled rejections ─────────────────────────
process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION! Shutting down...', reason);
    if (server) {
        server.close(() => {
            process.exit(1);
        });
    } else {
        process.exit(1);
    }
});

// ─── Handle uncaught exceptions ──────────────────────────
process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION! Shutting down...', error);
    process.exit(1);
});

// ─── Handle SIGTERM ──────────────────────────────────────
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    if (server) {
        server.close(() => {
            logger.info('Process terminated');
        });
    }
});

startServer();
