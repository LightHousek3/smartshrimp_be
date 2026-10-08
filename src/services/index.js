const authService = require('./auth.service');
const adminAccountService = require('./adminAccount.service');
const verificationService = require('./verification.service');
const profileService = require('./profile.service');
const farmService = require('./farm.service');
const notificationService = require('./notification.service');
const pondService = require('./pond.service');
const personnelService = require('./personnel.service');
const seasonService = require('./season.service');
const assignedSeasonService = require('./assignedSeason.service');
const expertDashboardService = require('./expertDashboard.service');
const expertSeasonService = require('./expertSeason.service');
const waterLogService = require('./waterLog.service');
const operationService = require('./operation.service');

module.exports = {
    authService,
    adminAccountService,
    verificationService,
    profileService,
    farmService,
    notificationService,
    pondService,
    personnelService,
    seasonService,
    assignedSeasonService,
    expertDashboardService,
    expertSeasonService,
    waterLogService,
    operationService,
};
