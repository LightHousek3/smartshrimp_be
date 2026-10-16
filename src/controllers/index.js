const authController = require('./auth.controller');
const adminAccountController = require('./adminAccount.controller');
const profileController = require('./profile.controller');
const farmController = require('./farm.controller');
const notificationController = require('./notification.controller');
const pondController = require('./pond.controller');
const personnelController = require('./personnel.controller');
const seasonController = require('./season.controller');
const assignedSeasonController = require('./assignedSeason.controller');
const expertDashboardController = require('./expertDashboard.controller');
const ownerDashboardController = require('./ownerDashboard.controller');
const expertSeasonController = require('./expertSeason.controller');
const expertProductionProtocolController = require('./expertProductionProtocol.controller');
const waterLogController = require('./waterLog.controller');
const operationController = require('./operation.controller');

const ragDocumentController = require('./ragDocument.controller');
const ragController = require('./rag.controller');

module.exports = {
    ragDocumentController,
    ragController,
    authController,
    adminAccountController,
    profileController,
    farmController,
    notificationController,
    pondController,
    personnelController,
    seasonController,
    assignedSeasonController,
    expertDashboardController,
    ownerDashboardController,
    expertSeasonController,
    expertProductionProtocolController,
    waterLogController,
    operationController,
};
