const express = require('express');
const { inventoryController } = require('../controllers');
const {
    authenticate,
    authorize,
    validate,
    requireIdempotencyKey,
} = require('../middlewares');
const { inventoryValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router({ mergeParams: true });
const supplierController = require('../controllers/supplier.controller');
const supplierValidator = require('../validators/supplier.validator');

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

router.get('/suppliers', validate(supplierValidator.getSuppliers), supplierController.getSuppliers);
router.post('/suppliers', validate(supplierValidator.createSupplier), supplierController.createSupplier);
router.get('/suppliers/:supplierId', validate(supplierValidator.getSupplier), supplierController.getSupplier);
router.patch('/suppliers/:supplierId', validate(supplierValidator.updateSupplier), supplierController.updateSupplier);
router.delete('/suppliers/:supplierId', validate(supplierValidator.deleteSupplier), supplierController.deleteSupplier);

router.get(
    '/inventory-transactions',
    validate(inventoryValidator.getInventoryHistory),
    inventoryController.getInventoryHistory,
);
router.get(
    '/products',
    validate(inventoryValidator.getProducts),
    inventoryController.getProducts,
);
router.post(
    '/products',
    validate(inventoryValidator.createProduct),
    inventoryController.createProduct,
);
router.get(
    '/products/:productId',
    validate(inventoryValidator.getProduct),
    inventoryController.getProduct,
);
router.patch(
    '/products/:productId',
    validate(inventoryValidator.updateProduct),
    inventoryController.updateProduct,
);
router.post(
    '/products/:productId/archive',
    validate(inventoryValidator.archiveProduct),
    inventoryController.archiveProduct,
);
router.delete(
    '/products/:productId',
    validate(inventoryValidator.deleteProduct),
    inventoryController.deleteProduct,
);
router.post(
    '/products/:productId/restore',
    validate(inventoryValidator.restoreProduct),
    inventoryController.restoreProduct,
);
router.post(
    '/products/:productId/stock-transactions',
    requireIdempotencyKey,
    validate(inventoryValidator.recordStockTransaction),
    inventoryController.recordStockTransaction,
);

module.exports = router;
