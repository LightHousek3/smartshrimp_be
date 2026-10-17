/**
 * Controller barrel used by route modules to access HTTP handlers through one entry point.
 * Register each controller here when adding routes that consume it.
 */
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
const inventoryController = require('./inventory.controller');
const supplierController = require('./supplier.controller');
const harvestController = require('./harvest.controller');

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
    inventoryController,
    supplierController,
    harvestController,
};
