const supplierService = require('../services/supplier.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getSuppliers = asyncHandler(async (req, res) => {
    const { suppliers, meta } = await supplierService.getSuppliers(
        req.params.farmId, req.account.id, req.query,
    );
    ResponseHandler.paginated(res, { data: suppliers, meta, message: messages.SUPPLIER.LIST_FETCHED });
});
const getSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.getSupplier(req.params.farmId, req.params.supplierId, req.account.id);
    ResponseHandler.success(res, { data, message: messages.SUPPLIER.FETCHED });
});
const createSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.createSupplier(req.params.farmId, req.body, req.account.id);
    ResponseHandler.created(res, { data, message: messages.SUPPLIER.CREATED });
});
const updateSupplier = asyncHandler(async (req, res) => {
    const data = await supplierService.updateSupplier(
        req.params.farmId, req.params.supplierId, req.body, req.account.id,
    );
    ResponseHandler.success(res, { data, message: messages.SUPPLIER.UPDATED });
});
const deleteSupplier = asyncHandler(async (req, res) => {
    await supplierService.deleteSupplier(req.params.farmId, req.params.supplierId, req.account.id);
    ResponseHandler.noContent(res);
});

module.exports = { getSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
