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
const shrimpHealthService = require('./shrimpHealth.service');
const operationService = require('./operation.service');
const notificationNavigationService = require('./notificationNavigation.service');
const taskService = require('./task.service');
const harvestService = require('./harvest.service');

const ragDocumentService = require('./ragDocument.service');
const ragService = require('./rag.service');
const ragClientService = require('./ragClient.service');
const ragStorageService = require('./ragStorage.service');

const protocolService = require('./protocol.service');

module.exports = {
    protocolService,
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
    shrimpHealthService,
    operationService,
    // Resolve linked inventory services after index initialization to avoid circular imports.
    get inventoryService() {
        return require('./inventory.service');
    },
    get inventoryHistoryOptionsService() {
        return require('./inventoryHistoryOptions.service');
    },
    get inventoryLegacyReadService() {
        return require('./inventoryLegacyRead.service');
    },
    get supplierService() {
        return require('./supplier.service');
    },
    notificationNavigationService,
    taskService,
    harvestService,
};
