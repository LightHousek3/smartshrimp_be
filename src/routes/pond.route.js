const express = require('express');
const { pondController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { pondValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/farms/:farmId/ponds
 * @desc    List non-deleted ponds in a farm owned by the authenticated Owner
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
 * @desc    Get a non-deleted pond in an owned farm
 * @access  Owner
 */
router.get('/:pondId', validate(pondValidator.getPond), pondController.getPond);

/**
 * @route   DELETE /api/v1/owner/farms/:farmId/ponds/:pondId
 * @desc    Soft-delete an owned pond that has no open season
 * @access  Owner
 */
router.delete('/:pondId', validate(pondValidator.deletePond), pondController.deletePond);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/ponds/:pondId
 * @desc    Update editable fields of a non-deleted owned pond
 * @access  Owner
 */
router.patch('/:pondId', validate(pondValidator.updatePond), pondController.updatePond);

module.exports = router;
