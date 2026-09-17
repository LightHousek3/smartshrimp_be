const express = require('express');
const { farmController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { farmValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/farms
 * @desc    List all active and archived farms owned by the authenticated Owner
 * @access  Owner
 */
router.get('/', farmController.getListFarm);

/**
 * @route   GET /api/v1/owner/farms/:farmId
 * @desc    Get an owned farm, including an archived farm
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
 * @route   PATCH /api/v1/owner/farms/:farmId/archive
 * @desc    Archive an owned farm that has no open season
 * @access  Owner
 */
router.patch(
    '/:farmId/archive',
    validate(farmValidator.changeArchiveStatus),
    farmController.archiveFarm,
);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId/restore
 * @desc    Restore an archived owned farm
 * @access  Owner
 */
router.patch(
    '/:farmId/restore',
    validate(farmValidator.changeArchiveStatus),
    farmController.restoreFarm,
);

/**
 * @route   PATCH /api/v1/owner/farms/:farmId
 * @desc    Update editable fields of an owned farm, including an archived farm
 * @access  Owner
 */
router.patch('/:farmId', validate(farmValidator.updateFarm), farmController.updateFarm);

module.exports = router;
