const { inventoryService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/farms/:farmId/products
 * Return the owned farm catalog with pagination and stock summaries.
 */
const getProducts = asyncHandler(async (req, res) => {
    const { products, meta } = await inventoryService.getProducts(
        req.params.farmId,
        req.account.id,
        req.query,
    );

    ResponseHandler.paginated(res, {
        message: messages.INVENTORY.LIST_FETCHED,
        data: products,
        meta,
    });
});

/**
 * GET /owner/farms/:farmId/products/:productId
 * Read lot details and pause eligibility through the owner-scoped service.
 */
const getProduct = asyncHandler(async (req, res) => {
    const product = await inventoryService.getProduct(
        req.params.farmId,
        req.params.productId,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.INVENTORY.FETCHED,
        data: product,
    });
});

/**
 * POST /owner/farms/:farmId/products
 * Take ownership from the session and pass validated catalog data to the service.
 */
const createProduct = asyncHandler(async (req, res) => {
    const product = await inventoryService.createProduct(
        req.params.farmId,
        req.body,
        req.account.id,
    );

    ResponseHandler.created(res, {
        message: messages.INVENTORY.CREATED,
        data: product,
    });
});

/**
 * PATCH /owner/farms/:farmId/products/:productId
 * Pass the version token to the service so stale edits are rejected.
 */
const updateProduct = asyncHandler(async (req, res) => {
    const product = await inventoryService.updateProduct(
        req.params.farmId,
        req.params.productId,
        req.body,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.INVENTORY.UPDATED,
        data: product,
    });
});

/**
 * POST /owner/farms/:farmId/products/:productId/archive
 * Stop new use while retaining existing stock, schedules and historical records.
 */
const archiveProduct = asyncHandler(async (req, res) => {
    const product = await inventoryService.archiveProduct(
        req.params.farmId,
        req.params.productId,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.INVENTORY.ARCHIVED,
        data: product,
    });
});

/**
 * POST /owner/farms/:farmId/products/:productId/restore
 * Resume an owned product while retaining its name, unit and historical references.
 */
const restoreProduct = asyncHandler(async (req, res) => {
    const product = await inventoryService.restoreProduct(
        req.params.farmId,
        req.params.productId,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.INVENTORY.RESTORED,
        data: product,
    });
});

/**
 * POST /owner/farms/:farmId/products/:productId/stock-transactions
 * Forward the idempotency key so a retry cannot create a duplicate movement.
 */
const recordStockTransaction = asyncHandler(async (req, res) => {
    const result = await inventoryService.recordStockTransaction(
        req.params.farmId,
        req.params.productId,
        req.body,
        req.account.id,
        req.idempotencyKey,
    );

    ResponseHandler.created(res, {
        message: messages.INVENTORY.TRANSACTION_RECORDED,
        data: result,
    });
});

/**
 * GET /owner/farms/:farmId/inventory-transactions
 * Return owner-scoped ledger entries and totals for the validated filters.
 */
const getInventoryHistory = asyncHandler(async (req, res) => {
    const { transactions, meta } = await inventoryService.getInventoryHistory(
        req.params.farmId,
        req.account.id,
        req.query,
    );

    ResponseHandler.paginated(res, {
        message: messages.INVENTORY.HISTORY_FETCHED,
        data: transactions,
        meta,
    });
});

/**
 * DELETE /owner/farms/:farmId/products/:productId
 * Delete only an unreferenced product and its owned compliance record.
 */
const deleteProduct = asyncHandler(async (req, res) => {
    await inventoryService.deleteProduct(req.params.farmId, req.params.productId, req.account.id);

    ResponseHandler.noContent(res);
});

/**
 * PATCH /owner/farms/:farmId/products/:productId/lots/:balanceId
 * Fill unknown expiry consistently across unused receipt layers of the same lot.
 */
const updateLotExpiry = asyncHandler(async (req, res) => {
    const lot = await inventoryService.updateLotExpiry(
        req.params.farmId,
        req.params.productId,
        req.params.balanceId,
        req.body,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.INVENTORY.UPDATED,
        data: lot,
    });
});

module.exports = {
    getProducts,
    getProduct,
    createProduct,
    updateProduct,
    archiveProduct,
    restoreProduct,
    deleteProduct,
    updateLotExpiry,
    recordStockTransaction,
    getInventoryHistory,
};
