const httpStatus = require('./httpStatus');
const messages = require('./messages');

/**
 * Enums matching the database schema
 */
const USER_ROLE = {
    ADMIN: 'ADMIN',
    FARM_OWNER: 'FARM_OWNER',
    TECHNICIAN: 'TECHNICIAN',
    EXPERT: 'EXPERT',
};

const ACCOUNT_STATUS = {
    PENDING_ACTIVATION: 'PENDING_ACTIVATION',
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    BLOCKED: 'BLOCKED',
};

const VERIFICATION_PURPOSE = {
    ACCOUNT_ACTIVATION: 'ACCOUNT_ACTIVATION',
    PASSWORD_RESET: 'PASSWORD_RESET',
};

module.exports = {
    httpStatus,
    messages,
    USER_ROLE,
    ACCOUNT_STATUS,
    VERIFICATION_PURPOSE,
};
