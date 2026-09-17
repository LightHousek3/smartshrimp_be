const httpStatus = require('./httpStatus');
const messages = require('./messages');
const NOTIFICATION_TYPE = require('./notificationType');

/**
 * Enums matching the database schema
 */
const ACCOUNT_ROLE = {
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
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    VERIFICATION_PURPOSE,
    NOTIFICATION_TYPE,
};
