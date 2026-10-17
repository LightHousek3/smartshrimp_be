const express = require('express');
const controller = require('../controllers/protocol.controller');
const validator = require('../validators/protocol.validator');
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
router.get('/', validate(validator.list), controller.list);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId
 * @desc    Get protocol details and status history
 * @access  Farm Owner
 */
router.get('/:protocolId', validate(validator.detail), controller.detail);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId/days/:day
 * @desc    Get planned and actual items for a protocol day
 * @access  Farm Owner
 */
router.get('/:protocolId/days/:day', validate(validator.day), controller.day);

/**
 * @route   GET /api/v1/owner/protocols/:protocolId/schedules/:scheduleId/inventory-transactions
 * @desc    Get inventory transactions for a protocol schedule
 * @access  Farm Owner
 */
router.get('/:protocolId/schedules/:scheduleId/inventory-transactions', validate(validator.inventory), controller.inventory);

/**
 * @route   POST /api/v1/owner/protocols/:protocolId/review
 * @desc    Approve or reject a submitted protocol
 * @access  Farm Owner
 */
router.post('/:protocolId/review', writeLimiter, validate(validator.review), controller.review);
module.exports = router;
