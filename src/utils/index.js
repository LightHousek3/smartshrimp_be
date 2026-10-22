const ApiError = require('./ApiError');
const asyncHandler = require('./asyncHandler');
const pick = require('./pick');
const ResponseHandler = require('./responseHandler');
const { createDocumentError, getDocumentErrorCode } = require('./ragDocumentError');
const { setRefreshTokenCookie, clearRefreshTokenCookie } = require('./refreshTokenCookie');
const { requireCompleteInventoryProduct } = require('./inventoryProductReadiness');

module.exports = {
    ApiError,
    asyncHandler,
    pick,
    ResponseHandler,
    createDocumentError,
    getDocumentErrorCode,
    setRefreshTokenCookie,
    clearRefreshTokenCookie,
    requireCompleteInventoryProduct,
    // Quantity helpers use ApiError from this index; defer loading until exports are ready.
    get stockQuantity() {
        return require('./inventoryQuantity').stockQuantity;
    },
    get vietnamDate() {
        return require('./inventoryQuantity').vietnamDate;
    },
};
