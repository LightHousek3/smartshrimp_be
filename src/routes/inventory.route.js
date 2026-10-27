const express = require('express');
const { inventoryController, supplierController } = require('../controllers');
const {
    authenticate,
    authorize,
    validate,
    requireIdempotencyKey,
} = require('../middlewares');
const { inventoryValidator, supplierValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router({ mergeParams: true });

/**
 * Apply the active-account and Owner gate to every inventory and supplier endpoint.
 */
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/farms/:farmId/suppliers
 * @desc    List the authenticated Owner directory across their farms
 * @access  Owner
 */
router.get('/suppliers', validate(supplierValidator.getSuppliers), supplierController.getSuppliers);

/**
 * @route   POST /api/v1/owner/farms/:farmId/suppliers
 * @desc    Create a supplier with owner-wide name uniqueness
 * @access  Owner
 */
router.post('/suppliers', validate(supplierValidator.createSupplier), supplierController.createSupplier);

/**
 * @route   GET /api/v1/owner/farms/:farmId/suppliers/:supplierId
 * @desc    Read a supplier belonging to the authenticated Owner
 * @access  Owner
 */
router.get('/suppliers/:supplierId', validate(supplierValidator.getSupplier), supplierController.getSupplier);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/suppliers/:supplierId
 * @desc    Update supplier details or activity with a version token
 * @access  Owner
 */
router.patch('/suppliers/:supplierId', validate(supplierValidator.updateSupplier), supplierController.updateSupplier);

/**
 * @route   DELETE /api/v1/owner/farms/:farmId/suppliers/:supplierId
 * @desc    Delete an unreferenced supplier; reject existing inventory and manufacturer links
 * @access  Owner
 */
router.delete('/suppliers/:supplierId', validate(supplierValidator.deleteSupplier), supplierController.deleteSupplier);

/**
 * @route   GET /api/v1/owner/farms/:farmId/inventory-transactions
 * @desc    Filter the owned farm ledger with cursor pagination and value totals
 * @access  Owner
 */
router.get(
    '/inventory-transactions',
    validate(inventoryValidator.getInventoryHistory),
    inventoryController.getInventoryHistory,
);

/**
 * @route   GET /api/v1/owner/farms/:farmId/products
 * @desc    List owned farm products with stock filters and summaries
 * @access  Owner
 */
router.get(
    '/products',
    validate(inventoryValidator.getProducts),
    inventoryController.getProducts,
);

/**
 * @route   POST /api/v1/owner/farms/:farmId/products
 * @desc    Create a product with a unique name and unit in the farm
 * @access  Owner
 */
router.post(
    '/products',
    validate(inventoryValidator.createProduct),
    inventoryController.createProduct,
);

/**
 * @route   GET /api/v1/owner/farms/:farmId/products/:productId
 * @desc    Read an owned product with its lots and pause eligibility
 * @access  Owner
 */
router.get(
    '/products/:productId',
    validate(inventoryValidator.getProduct),
    inventoryController.getProduct,
);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/products/:productId
 * @desc    Update an active product without changing units already used in the ledger
 * @access  Owner
 */
router.patch(
    '/products/:productId',
    validate(inventoryValidator.updateProduct),
    inventoryController.updateProduct,
);

/**
 * @route   POST /api/v1/owner/farms/:farmId/products/:productId/archive
 * @desc    Stop new use without deleting stock or cancelling existing schedules
 * @access  Owner
 */
router.post(
    '/products/:productId/archive',
    validate(inventoryValidator.archiveProduct),
    inventoryController.archiveProduct,
);

/**
 * @route   POST /api/v1/owner/farms/:farmId/products/:productId/restore
 * @desc    Resume an inactive product retaining its reserved name and unit
 * @access  Owner
 */
router.post(
    '/products/:productId/restore',
    validate(inventoryValidator.restoreProduct),
    inventoryController.restoreProduct,
);

/**
 * @route   POST /api/v1/owner/farms/:farmId/products/:productId/stock-transactions
 * @desc    Record a receipt, issue or adjustment with an idempotency key
 * @access  Owner
 */
router.post(
    '/products/:productId/stock-transactions',
    requireIdempotencyKey,
    validate(inventoryValidator.recordStockTransaction),
    inventoryController.recordStockTransaction,
);

/**
 * @route   DELETE /api/v1/owner/farms/:farmId/products/:productId
 * @desc    Delete an unreferenced product and its owned compliance row
 * @access  Owner
 */
router.delete('/products/:productId', validate(inventoryValidator.deleteProduct), inventoryController.deleteProduct);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/products/:productId/lots/:balanceId
 * @desc    Fill an unknown expiry across unused receipt layers of the same manufacturer lot
 * @access  Owner
 */
router.patch('/products/:productId/lots/:balanceId', validate(inventoryValidator.updateLotExpiry), inventoryController.updateLotExpiry);

module.exports = router;
