const authValidator = require('./auth.validator');
const adminAccountValidator = require('./adminAccount.validator');
const profileValidator = require('./profile.validator');
const farmValidator = require('./farm.validator');
const notificationValidator = require('./notification.validator');
const pondValidator = require('./pond.validator');
const personnelValidator = require('./personnel.validator');
const seasonValidator = require('./season.validator');

module.exports = {
    authValidator,
    adminAccountValidator,
    profileValidator,
    farmValidator,
    notificationValidator,
    pondValidator,
    personnelValidator,
    seasonValidator,
};
