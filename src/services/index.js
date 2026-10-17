/**
 * Service barrel used by controllers to access backend business operations.
 * Services that depend on sibling services use direct imports to avoid re-entering this barrel.
 */
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
const ownerDashboardService = require('./ownerDashboard.service');
const expertSeasonService = require('./expertSeason.service');
const expertProductionProtocolService = require('./expertProductionProtocol.service');
const waterLogService = require('./waterLog.service');
const operationService = require('./operation.service');
const inventoryService = require('./inventory.service');
const supplierService = require('./supplier.service');
const notificationNavigationService = require('./notificationNavigation.service');
const harvestService = require('./harvest.service');

const ragDocumentService = require('./ragDocument.service');
const ragService = require('./rag.service');
const ragClientService = require('./ragClient.service');
const ragStorageService = require('./ragStorage.service');

module.exports = {
    ragDocumentService,
    ragService,
    ragClientService,
    ragStorageService,
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
    ownerDashboardService,
    expertSeasonService,
    expertProductionProtocolService,
    waterLogService,
    operationService,
    inventoryService,
    supplierService,
    notificationNavigationService,
    harvestService,
};
