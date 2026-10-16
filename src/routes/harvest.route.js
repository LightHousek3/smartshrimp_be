/**
 * Owner-only harvest endpoints mounted at /owner/seasons/:seasonId/harvests.
 * Shared authentication and role checks run before endpoint-specific validation.
 */
const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { harvestValidator: validator } = require('../validators');
const { harvestController: controller } = require('../controllers');

// Preserve seasonId from the parent mount path for validation and ownership checks.
const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));
router.get('/', validate(validator.list), controller.list);
router.get('/:harvestId', validate(validator.detail), controller.detail);
// Validate the retry key before allowing the request to reach the write flow.
router.post('/', validator.idempotency, validate(validator.create), controller.create);
module.exports = router;
