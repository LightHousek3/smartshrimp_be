const httpStatus = require('./httpStatus');
const messages = require('./messages');

/**
 * Enums matching the database schema
 */
const USER_ROLE = {
    ADMIN: 'ADMIN',
};

const ACCOUNT_STATUS = {};

module.exports = {
    httpStatus,
    messages,
    USER_ROLE,
    ACCOUNT_STATUS,
};
