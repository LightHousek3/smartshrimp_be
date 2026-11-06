const express = require('express');
const { pondController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { pondValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

// Preserve farmId from the parent route for validation and ownership checks.
const router = express.Router({ mergeParams: true });
// Role checks apply to every endpoint; the service checks ownership per resource.
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/farms/:farmId/ponds
 * @desc    List ponds in a farm owned by the authenticated Owner
 * @access  Owner
 */
router.get('/', validate(pondValidator.getPonds), pondController.getPonds);

/**
 * @route   POST /api/v1/owner/farms/:farmId/ponds
 * @desc    Create a pond in an owned farm
 * @access  Owner
 */
router.post('/', validate(pondValidator.createPond), pondController.createPond);

/**
 * @route   GET /api/v1/owner/farms/:farmId/ponds/:pondId
 * @desc    Get a pond in an owned farm
 * @access  Owner
 */
router.get('/:pondId', validate(pondValidator.getPond), pondController.getPond);

/**
 * @route   DELETE /api/v1/owner/farms/:farmId/ponds/:pondId
 * @desc    Delete an owned pond; reject open seasons and foreign-key references
 * @access  Owner
 */
router.delete('/:pondId', validate(pondValidator.deletePond), pondController.deletePond);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/ponds/:pondId
 * @desc    Update an owned pond with fixed dimensions; open seasons allow volume changes but protect type/readiness
 * @access  Owner
 */
router.patch('/:pondId', validate(pondValidator.updatePond), pondController.updatePond);

module.exports = router;
