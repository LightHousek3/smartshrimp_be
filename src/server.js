const { createServer } = require('node:http');
const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const connectDB = require('./config/db');
const prisma = require('./config/prisma');
const redis = require('./config/redis');
const jobs = require('./jobs');
const { attachNotificationSocket, closeNotificationAdapter } = require('./realtime/notification.socket');
const { errorDetail } = require('./utils/productionSchedule');

let server;
let socketServer;
let shuttingDown;

/** Bind HTTP and realtime before starting jobs that publish notifications. */
const startServer = async () => {
    await connectDB();
    if (shuttingDown) {
        await prisma.$disconnect();
        return;
    }

    server = createServer(app);
    socketServer = attachNotificationSocket(server);
    await new Promise((resolve, reject) => {
        // Reject bind failures before any background job can claim work.
        const failed = (error) => reject(error);
        server.once('error', failed);
        server.listen(config.port, () => {
            server.off('error', failed);
            logger.info(`
    ╔═══════════════════════════════════════════════════╗
    ║   Smart Shrimp                                    ║
    ║   Environment: ${config.env.padEnd(24)}           ║
    ║   Port: ${String(config.port).padEnd(33)}         ║
    ║   API: ${config.apiPrefix.padEnd(30)}             ║
    ╚═══════════════════════════════════════════════════╝
    `);
            resolve();
        });
    });
    server.on('error', (error) => fatal('HTTP server failure', error));
    if (shuttingDown) return;
    redis.start();
    await jobs.start();
    if (!shuttingDown) app.locals.ready = true;
};

/** Drain requests and claimed jobs before disconnecting their shared database pool. */
const shutdown = (reason, exitCode = 0) => {
    if (exitCode) process.exitCode = exitCode;
    if (shuttingDown) return shuttingDown;

    app.locals.ready = false;
    logger.info(`Shutting down: ${reason}.`);
    const timeout = setTimeout(() => {
        logger.error('Graceful shutdown exceeded its time limit.');
        process.exit(1);
    }, config.jobs.shutdownTimeoutMs);
    timeout.unref();

    shuttingDown = (async () => {
        const stoppedJobs = jobs.stop();
        socketServer?.local.disconnectSockets(true);
        if (server?.listening) {
            await new Promise((resolve) => {
                server.close(resolve);
                server.closeIdleConnections?.();
            });
        }
        await stoppedJobs;
        if (socketServer) await new Promise((resolve) => socketServer.close(resolve));
        closeNotificationAdapter();
        redis.stop();
        await prisma.$disconnect();
        clearTimeout(timeout);
        logger.info('Shutdown completed.');
    })().catch(() => {
        logger.error('Graceful shutdown failed.');
        process.exit(1);
    });
    return shuttingDown;
};

/** Route startup and process failures through the same bounded shutdown. */
const fatal = (reason, error) => {
    if (error?.code === 'EADDRINUSE') {
        logger.error(
            `Port ${config.port} is already in use. Stop the existing API process before starting another server.`,
        );
    }
    logger.error(`${reason}: ${errorDetail(error)}`);
    void shutdown(reason, 1);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error) => fatal('unhandled rejection', error));
process.on('uncaughtException', (error) => fatal('uncaught exception', error));

startServer().catch((error) => fatal('startup failed', error));
