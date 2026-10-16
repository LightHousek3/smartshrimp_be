const { Server } = require('socket.io');
const config = require('../config');
const { ACCOUNT_ROLE } = require('../constants');
const { loadActiveAccount } = require('../middlewares');

let io;

/**
 * Build the private Socket.IO room name used for one notification recipient.
 * @param {string} accountId - Recipient account ID
 * @returns {string} Account room name
 */
const accountRoom = (accountId) => `account:${accountId}`;
const allowedRoles = new Set([
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.EXPERT,
    ACCOUNT_ROLE.FARM_OWNER,
]);

/**
 * Attach Socket.IO to the HTTP server and authenticate notification connections.
 * Active technicians, experts, and farm owners join their own account room.
 *
 * @param {Object} httpServer - HTTP server hosting the API
 * @returns {Server} Initialized Socket.IO server
 */
const attachNotificationSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: { origin: config.cors.origin, credentials: true },
    });

    /**
     * Socket middleware: verify the handshake access token and recipient role.
     * Store the verified account ID for room assignment; reject invalid credentials.
     */
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

    // Derive the room from the verified account, rather than a client-provided ID.
    io.on('connection', (socket) => {
        socket.join(accountRoom(socket.data.accountId));
    });

    return io;
};

/**
 * Emit a notification event to all connected sockets belonging to one account.
 * Calls before socket initialization are safely ignored.
 *
 * @param {string} accountId - Recipient account ID
 * @param {string} event - notification:new, notification:read, or notification:read-all
 * @param {Object} payload - Event data used by clients to synchronize notifications
 */
const emitNotification = (accountId, event, payload) => {
    if (io) io.to(accountRoom(accountId)).emit(event, payload);
};

module.exports = { attachNotificationSocket, emitNotification };
