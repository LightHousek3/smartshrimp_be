const app = require('./app');
const { createServer } = require('node:http');
const config = require('./config');
const logger = require('./config/logger');
const connectDB = require('./config/db');
const prisma = require('./config/prisma');
const { attachNotificationSocket } = require('./realtime/notification.socket');

let server;
let socketServer;

const startServer = async () => {
    // Connect to Postgre
    await connectDB();

    server = createServer(app);
    socketServer = attachNotificationSocket(server);
    server.listen(config.port, () => {
        logger.info(`
    ╔═══════════════════════════════════════════════════╗
    ║   Smart Shrimp                                    ║
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
        socketServer.close(() => {
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
        socketServer.close(async () => {
            await prisma.$disconnect();
            logger.info('Process terminated');
        });
    }
});

startServer();
