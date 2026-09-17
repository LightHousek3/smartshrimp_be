const authValidator = require('./auth.validator');
const adminAccountValidator = require('./adminAccount.validator');
const profileValidator = require('./profile.validator');
const notificationValidator = require('./notification.validator');

module.exports = {
    authValidator,
    adminAccountValidator,
    profileValidator,
    notificationValidator,
};
