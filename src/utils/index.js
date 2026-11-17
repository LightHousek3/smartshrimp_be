const ApiError = require('./ApiError');
const asyncHandler = require('./asyncHandler');
const pick = require('./pick');
const ResponseHandler = require('./responseHandler');
const { createDocumentError, getDocumentErrorCode } = require('./ragDocumentError');
const { setRefreshTokenCookie, clearRefreshTokenCookie } = require('./refreshTokenCookie');
const { requireCompleteInventoryProduct } = require('./inventoryProductReadiness');
const { stockQuantity, vietnamDate } = require('./inventoryQuantity');
const { assertTemplateDose } = require('./protocolTemplateRules');
const { applicationRuns } = require('./templateApplicationDays');
const protocolStructure = require('./protocolStructure');
const productionSchedule = require('./productionSchedule');
const { assertProtocolHarvestCoverage } = require('./productionProtocol');
const {
    getMaterialSafety,
    assertMaterialSafety,
    assessTemplateProposal,
    productFromRecommendation,
} = require('./materialCompliance');
const {
    searchSubstances,
    checkIngredients,
    requireUsableIngredients,
} = require('./inventorySubstances');

const recognitionResult = require('./aiRecognition');

module.exports = {
    recognitionResult,
    assertProtocolHarvestCoverage,
    productionSchedule,
    protocolStructure,
    assertTemplateDose,
    applicationRuns,
    getMaterialSafety,
    assertMaterialSafety,
    assessTemplateProposal,
    productFromRecommendation,
    searchSubstances,
    checkIngredients,
    requireUsableIngredients,
    ApiError,
    asyncHandler,
    pick,
    ResponseHandler,
    createDocumentError,
    getDocumentErrorCode,
    setRefreshTokenCookie,
    clearRefreshTokenCookie,
    requireCompleteInventoryProduct,
    stockQuantity,
    vietnamDate,
};
