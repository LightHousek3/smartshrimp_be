const { Server } = require('socket.io');
const config = require('../config');
const logger = require('../config/logger');
const { ACCOUNT_ROLE } = require('../constants');
const { loadActiveAccount } = require('../middlewares');

let io;

/**
 * Use a private room per account so its authenticated sockets receive the same inbox updates.
 */
const accountRoom = (accountId) => `account:${accountId}`;
const allowedRoles = new Set([
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.EXPERT,
    ACCOUNT_ROLE.FARM_OWNER,
]);

/**
 * Authenticate each connection against the current account and restrict room access to supported
 * roles.
 */
const attachNotificationSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: { origin: config.cors.origin, credentials: true },
    });

    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (typeof token !== 'string' || !token) {
                throw new Error('Missing access token');
            }
            const account = await loadActiveAccount(token);
            if (!allowedRoles.has(account.role)) {
                throw new Error('Role cannot receive notifications');
            }
            socket.data.accountId = account.id;
            next();
        } catch (_) {
            next(new Error('Unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        socket.join(accountRoom(socket.data.accountId));
    });

    return io;
};

/**
 * Deliver an inbox event to the account room on a best-effort basis after persistence.
 */
const emitNotification = (accountId, event, payload) => {
    if (!io) return;
    try {
        io.to(accountRoom(accountId)).emit(event, payload);
    } catch (_) {
        // The notification is already persisted; a transport failure must not fail the committed mutation.
        logger.warn('Realtime notification delivery failed; notification remains available via API.');
    }
};

module.exports = { attachNotificationSocket, emitNotification };
