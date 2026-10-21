const { supplierService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /owner/farms/:farmId/suppliers
 * List the owner-wide directory after the service verifies access to the destination farm.
 */
const getSuppliers = asyncHandler(async (req, res) => {
    const { suppliers, meta } = await supplierService.getSuppliers(
        req.params.farmId, req.account.id, req.query,
    );
    ResponseHandler.paginated(res, { data: suppliers, meta, message: messages.SUPPLIER.LIST_FETCHED });
});

/**
 * GET /owner/farms/:farmId/suppliers/:supplierId
 * Allow a supplier from another farm only when both farms belong to the same owner.
 */
const getSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.getSupplier(req.params.farmId, req.params.supplierId, req.account.id);
    ResponseHandler.success(res, { data, message: messages.SUPPLIER.FETCHED });
});

/**
 * POST /owner/farms/:farmId/suppliers
 * Keep the destination farm as the supplier origin and check names across the owner directory.
 */
const createSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.createSupplier(req.params.farmId, req.body, req.account.id);
    ResponseHandler.created(res, { data, message: messages.SUPPLIER.CREATED });
});

/**
 * PATCH /owner/farms/:farmId/suppliers/:supplierId
 * Forward the version token for an owner-scoped update, including activity changes.
 */
const updateSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.updateSupplier(
        req.params.farmId, req.params.supplierId, req.body, req.account.id,
    );
    ResponseHandler.success(res, { data, message: messages.SUPPLIER.UPDATED });
});

/**
 * DELETE /owner/farms/:farmId/suppliers/:supplierId
 * Return no content after soft deletion preserves receipt references and snapshots.
 */
const deleteSupplier = asyncHandler(async (req, res) => {
    await supplierService.deleteSupplier(req.params.farmId, req.params.supplierId, req.account.id);
    ResponseHandler.noContent(res);
});

module.exports = { getSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
