const express = require('express');
const { adminAccountController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { adminAccountValidator } = require('../validators');
const { USER_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(USER_ROLE.ADMIN));

/**
 * @route   GET /api/v1/admin/accounts
 * @desc    List accounts with filters and cursor pagination
 * @access  Admin
 */
router.get(
    '/',
    validate(adminAccountValidator.getListAccount),
    adminAccountController.getListAccount,
);

/**
 * @route   GET /api/v1/admin/accounts/:accountId
 * @desc    Get account details
 * @access  Admin
 */
router.get(
    '/:accountId',
    validate(adminAccountValidator.getAccount),
    adminAccountController.getAccount,
);

/**
 * @route   POST /api/v1/admin/accounts
 * @desc    Create a managed account pending activation
 * @access  Admin
 */
router.post('/', validate(adminAccountValidator.createAccount), adminAccountController.createAccount);

/**
 * @route   POST /api/v1/admin/accounts/:accountId/resend-activation
 * @desc    Resend an activation email to a pending account
 * @access  Admin
 */
router.post(
    '/:accountId/resend-activation',
    validate(adminAccountValidator.resendActivation),
    adminAccountController.resendActivation,
);

/**
 * @route   PATCH /api/v1/admin/accounts/:accountId/status
 * @desc    Change account status and revoke sessions when access is disabled
 * @access  Admin
 */
router.patch(
    '/:accountId/status',
    validate(adminAccountValidator.updateAccountStatus),
    adminAccountController.updateAccountStatus,
);

module.exports = router;
