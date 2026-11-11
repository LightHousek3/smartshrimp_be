const expertDiseaseCaseValidator = require('./expertDiseaseCase.validator');
const ownerDiseaseCaseValidator = require('./ownerDiseaseCase.validator');
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
const ownerDashboardValidator = require('./ownerDashboard.validator');
const technicianDashboardValidator = require('./technicianDashboard.validator');
const expertSeasonValidator = require('./expertSeason.validator');
const expertProductionProtocolValidator = require('./expertProductionProtocol.validator');
const expertProtocolTemplateValidator = require('./expertProtocolTemplate.validator');
const waterLogValidator = require('./waterLog.validator');
const shrimpHealthValidator = require('./shrimpHealth.validator');
const operationValidator = require('./operation.validator');
const inventoryValidator = require('./inventory.validator');
const inventoryLabelValidator = require('./inventoryLabel.validator');
const inventorySubstanceValidator = require('./inventorySubstance.validator');
const supplierValidator = require('./supplier.validator');
const taskValidator = require('./task.validator');
const harvestValidator = require('./harvest.validator');

const ragDocumentValidator = require('./ragDocument.validator');
const ragValidator = require('./rag.validator');

const protocolValidator = require('./protocol.validator');

const aiDiagnosisValidator = require('./aiDiagnosis.validator');

const diseaseCaseValidator = require('./diseaseCase.validator');
module.exports = {
    aiDiagnosisValidator,
    diseaseCaseValidator,
    protocolValidator,
    ragDocumentValidator,
    ragValidator,
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
    ownerDashboardValidator,
    technicianDashboardValidator,
    expertSeasonValidator,
    expertProductionProtocolValidator,
    expertProtocolTemplateValidator,
    waterLogValidator,
    shrimpHealthValidator,
    operationValidator,
    inventoryValidator,
    inventoryLabelValidator,
    inventorySubstanceValidator,
    supplierValidator,
    taskValidator,
    harvestValidator,
    expertDiseaseCaseValidator,
    ownerDiseaseCaseValidator,
};
