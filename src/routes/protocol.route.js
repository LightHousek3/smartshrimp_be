const express = require('express');
const { protocolController } = require('../controllers');
const { protocolValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');
const { authenticate, authorize, validate, writeLimiter } = require('../middlewares');
const router = express.Router();

// ─── Owner Protocols ─────────────────────────────────────────────────────────

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/protocols
 * @desc    List submitted versions; status=PENDING_APPROVAL selects the owner's approval inbox
 * @access  Farm Owner
 */
router.get('/', validate(protocolValidator.list), protocolController.list);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId
 * @desc    Get protocol details and status history
 * @access  Farm Owner
 */
router.get('/:protocolId', validate(protocolValidator.detail), protocolController.detail);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId/days/:day
 * @desc    Get planned and actual items for a protocol day
 * @access  Farm Owner
 */
router.get('/:protocolId/days/:day', validate(protocolValidator.day), protocolController.day);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId/schedules/:scheduleId/inventory-transactions
 * @desc    Get inventory transactions for a protocol schedule
 * @access  Farm Owner
 */
router.get('/:protocolId/schedules/:scheduleId/inventory-transactions', validate(protocolValidator.inventory), protocolController.inventory);

/**
 * @route   POST /api/v1/owner/protocols/:protocolId/review
 * @desc    Approve or reject a submitted protocol
 * @access  Farm Owner
 */
router.post('/:protocolId/review', writeLimiter, validate(protocolValidator.review), protocolController.review);
module.exports = router;
