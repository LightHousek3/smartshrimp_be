const express = require('express');
const { authController } = require('../controllers');
const { validate, authLimiter } = require('../middlewares');
const { authValidator } = require('../validators');

const router = express.Router();

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * @route   POST /api/v1/auth/login
 * @desc    Login user (only ACTIVE accounts)
 * @access  Public
 */
router.post('/login', authLimiter, validate(authValidator.login), authController.login);

/**
 * @route   POST /api/v1/auth/logout
 * @desc    Logout user (revoke refresh token)
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

module.exports = router;
