const { Server } = require('socket.io');
const config = require('../config');
const { ACCOUNT_ROLE } = require('../constants');
const { loadActiveAccount } = require('../middlewares/auth.middleware');

let io;

const accountRoom = (accountId) => `account:${accountId}`;
const allowedRoles = new Set([
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.EXPERT,
    ACCOUNT_ROLE.FARM_OWNER,
]);

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

const emitNotification = (accountId, event, payload) => {
    if (io) io.to(accountRoom(accountId)).emit(event, payload);
};

module.exports = { attachNotificationSocket, emitNotification };
