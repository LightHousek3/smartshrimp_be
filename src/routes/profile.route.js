const express = require('express');
const { profileController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { profileValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();
const PROFILE_ROLES = [
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.FARM_OWNER,
    ACCOUNT_ROLE.EXPERT,
];

/**
 * @route   GET /api/v1/profile
 * @desc    Get the authenticated Technician, Owner, or Expert profile
 * @access  Private
 */
router.get(
    '/',
    authenticate,
    authorize(...PROFILE_ROLES),
    profileController.getProfile,
);

/**
 * @route   PATCH /api/v1/profile
 * @desc    Update editable fields of the authenticated account's profile
 * @access  Private
 */
router.patch(
    '/',
    authenticate,
    authorize(...PROFILE_ROLES),
    validate(profileValidator.updateProfile),
    profileController.updateProfile,
);

/**
 * @route   PATCH /api/v1/profile/password
 * @desc    Change password and revoke every refresh-token session
 * @access  Private
 */
router.patch(
    '/password',
    authenticate,
    authorize(...PROFILE_ROLES),
    validate(profileValidator.changePassword),
    profileController.changePassword,
);

module.exports = router;
