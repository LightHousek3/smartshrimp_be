const authValidator = require('./auth.validator');
const adminAccountValidator = require('./adminAccount.validator');
const profileValidator = require('./profile.validator');
const farmValidator = require('./farm.validator');
const notificationValidator = require('./notification.validator');
const pondValidator = require('./pond.validator');
const personnelValidator = require('./personnel.validator');
const seasonValidator = require('./season.validator');
const assignedSeasonValidator = require('./assignedSeason.validator');
const expertDashboardValidator = require('./expertDashboard.validator');
const expertSeasonValidator = require('./expertSeason.validator');
const waterLogValidator = require('./waterLog.validator');
const operationValidator = require('./operation.validator');

module.exports = {
    authValidator,
    adminAccountValidator,
    profileValidator,
    farmValidator,
    notificationValidator,
    pondValidator,
    personnelValidator,
    seasonValidator,
    assignedSeasonValidator,
    expertDashboardValidator,
    expertSeasonValidator,
    waterLogValidator,
    operationValidator,
};
