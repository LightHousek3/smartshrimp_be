/**
 * Owner-only harvest endpoints mounted at /owner/seasons/:seasonId/harvests.
 * Shared authentication and role checks run before endpoint-specific validation.
 */
const express = require('express');
const { authenticate, authorize, validate, requireIdempotencyKey } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { harvestValidator: validator } = require('../validators');
const { harvestController: controller } = require('../controllers');

// Preserve seasonId from the parent mount path for validation and ownership checks.
const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/seasons/:seasonId/harvests
 * @desc    List harvest history and totals for a season owned by the authenticated Owner
 * @access  Private (FARM_OWNER)
 */
router.get('/', validate(validator.list), controller.list);

/**
 * @route   GET /api/v1/owner/seasons/:seasonId/harvests/:harvestId
 * @desc    Read an immutable harvest belonging to the Owner's season
 * @access  Private (FARM_OWNER)
 */
router.get('/:harvestId', validate(validator.detail), controller.detail);

/**
 * @route   POST /api/v1/owner/seasons/:seasonId/harvests
 * @desc    Record a partial/final harvest or replay a saved request using Idempotency-Key
 * @access  Private (FARM_OWNER)
 */
router.post('/', requireIdempotencyKey, validate(validator.create), controller.create);
module.exports = router;
