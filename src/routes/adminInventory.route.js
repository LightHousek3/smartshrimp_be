const express = require('express');
const { inventoryController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { inventoryValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.ADMIN));

/**
 * @route   GET /api/v1/admin/inventory/products
 * @desc    List product compliance records by status, defaulting to the draft queue
 * @access  Admin
 */
router.get('/products', validate(inventoryValidator.getProductsForReview), inventoryController.getProductsForReview);

/**
 * @route   GET /api/v1/admin/inventory/products/:productId
 * @desc    Read manufacturer and label evidence before reviewing compliance
 * @access  Admin
 */
router.get('/products/:productId', validate(inventoryValidator.getProductForReview), inventoryController.getProductForReview);

/**
 * @route   POST /api/v1/admin/inventory/products/:productId/compliance-review
 * @desc    Review or block the current product version with a recorded reason
 * @access  Admin
 */
router.post(
    '/products/:productId/compliance-review',
    validate(inventoryValidator.reviewProductCompliance),
    inventoryController.reviewProductCompliance,
);

module.exports = router;
