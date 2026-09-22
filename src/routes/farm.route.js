const express = require('express');
const { farmController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { farmValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/farms
 * @desc    List non-deleted farms owned by the authenticated Owner
 * @access  Owner
 */
router.get('/', farmController.getListFarm);

/**
 * @route   GET /api/v1/owner/farms/:farmId
 * @desc    Get a non-deleted owned farm
 * @access  Owner
 */
router.get('/:farmId', validate(farmValidator.getFarm), farmController.getFarm);

/**
 * @route   POST /api/v1/owner/farms
 * @desc    Create a farm for the authenticated Owner
 * @access  Owner
 */
router.post('/', validate(farmValidator.createFarm), farmController.createFarm);

/**
 * @route   DELETE /api/v1/owner/farms/:farmId
 * @desc    Soft-delete an owned farm that has no open season
 * @access  Owner
 */
router.delete('/:farmId', validate(farmValidator.deleteFarm), farmController.deleteFarm);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId
 * @desc    Update editable fields of a non-deleted owned farm
 * @access  Owner
 */
router.patch('/:farmId', validate(farmValidator.updateFarm), farmController.updateFarm);

module.exports = router;
