const express = require('express');
const { authController } = require('../controllers');
const { validate, authLimiter } = require('../middlewares');
const { authValidator } = require('../validators');

const router = express.Router();

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/auth/login
 * @desc    Login account (only ACTIVE accounts)
 * @access  Public
 */
router.post('/login', authLimiter, validate(authValidator.login), authController.login);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout account (revoke refresh token)
 * @access  Public
 */
router.post('/logout', validate(authValidator.logout), authController.logout);

/**
 * @route   POST /api/v1/auth/refresh-token
 * @desc    Refresh access token
 * @access  Public
 */
router.post(
    '/refresh-token',
    authLimiter,
    validate(authValidator.refreshTokens),
    authController.refreshTokens,
);

/**
 * @route   POST /api/v1/auth/activation/request-otp
 * @desc    Send account activation OTP
 * @access  Public
 */
router.post(
    '/activation/request-otp',
    authLimiter,
    validate(authValidator.requestOtp),
    authController.requestActivationOtp,
);

/**
 * @route   POST /api/v1/auth/activation/verify-otp
 * @desc    Verify account activation OTP
 * @access  Public
 */
router.post(
    '/activation/verify-otp',
    authLimiter,
    validate(authValidator.verifyOtp),
    authController.verifyActivationOtp,
);

/**
 * @route   POST /api/v1/auth/activation/complete
 * @desc    Complete account activation
 * @access  Public
 */
router.post(
    '/activation/complete',
    authLimiter,
    validate(authValidator.activateAccount),
    authController.activateAccount,
);

/**
 * @route   POST /api/v1/auth/forgot-password/request-otp
 * @desc    Send password reset OTP
 * @access  Public
 */
router.post(
    '/forgot-password/request-otp',
    authLimiter,
    validate(authValidator.requestOtp),
    authController.requestPasswordResetOtp,
);

/**
 * @route   POST /api/v1/auth/forgot-password/verify-otp
 * @desc    Verify password reset OTP
 * @access  Public
 */
router.post(
    '/forgot-password/verify-otp',
    authLimiter,
    validate(authValidator.verifyOtp),
    authController.verifyPasswordResetOtp,
);

/**
 * @route   POST /api/v1/auth/forgot-password/reset
 * @desc    Reset account password
 * @access  Public
 */
router.post(
    '/forgot-password/reset',
    authLimiter,
    validate(authValidator.resetPassword),
    authController.resetPassword,
);

module.exports = router;
