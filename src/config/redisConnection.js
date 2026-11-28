const { createClient } = require('redis');
const logger = require('./logger');

const COMMAND_TIMEOUT_MS = 100;
const WARNING_INTERVAL_MS = 60_000;

/** Register error handling before connecting; Redis may recover after the HTTP server starts. */
const openRedisConnection = (url, purpose, onUnavailable, { subscribe = false } = {}) => {
    let nextWarningAt = 0;
    let closed = false;
    const warn = () => {
        const now = Date.now();
        if (closed || now < nextWarningAt) return;
        nextWarningAt = now + WARNING_INTERVAL_MS;
        logger.warn(`Redis ${purpose} unavailable. ${onUnavailable}`);
    };
    try {
        const client = createClient({
            url,
            socket: subscribe ? { connectTimeout: 1000 } : { connectTimeout: 1000, socketTimeout: 60_000 },
            ...(subscribe ? {} : { pingInterval: 30_000 }),
            disableOfflineQueue: !subscribe,
            commandsQueueMaxLength: 64,
        });
        client.on('error', warn);
        client.on('ready', () => {
            nextWarningAt = 0;
            logger.info(`Redis ${purpose} connected.`);
        });
        void client.connect().catch(warn);
        return {
            client,
            warn,
            close: () => {
                closed = true;
                if (client.isOpen) client.destroy();
            },
        };
    } catch {
        warn();
        return undefined;
    }
};

/** Bound the caller's wait even if a command has already reached the socket. */
const runRedisCommand = async (connection, command) => {
    if (!connection?.client.isReady) throw new Error('Redis connection is not ready');
    const controller = new AbortController();
    let timer;
    try {
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error('Redis command timed out'));
                controller.abort();
            }, COMMAND_TIMEOUT_MS);
        });
        return await Promise.race([
            command(connection.client.withAbortSignal(controller.signal)),
            deadline,
        ]);
    } catch (error) {
        connection.warn();
        throw error;
    } finally {
        clearTimeout(timer);
    }
};

module.exports = { openRedisConnection, runRedisCommand };
