const { inventoryService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

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

const deleteProduct = asyncHandler(async (req, res) => {
    await inventoryService.deleteProduct(req.params.farmId, req.params.productId, req.account.id);
    ResponseHandler.noContent(res);
});

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

module.exports = {
    getProducts,
    getProduct,
    createProduct,
    updateProduct,
    archiveProduct,
    deleteProduct,
    restoreProduct,
    recordStockTransaction,
    getInventoryHistory,
};
