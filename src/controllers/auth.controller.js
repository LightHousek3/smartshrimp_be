const { authService, verificationService } = require('../services');
const {
    asyncHandler,
    ResponseHandler,
    setRefreshTokenCookie,
    clearRefreshTokenCookie,
} = require('../utils');
const { messages, VERIFICATION_PURPOSE } = require('../constants');
const config = require('../config');

/**
 * POST /auth/login
 */
const login = asyncHandler(async (req, res) => {
    const { email, password, deviceId } = req.body;
    const { account, tokens } = await authService.login(email, password, deviceId);

    setRefreshTokenCookie(res, tokens.refreshToken);

    ResponseHandler.success(res, {
        message: messages.AUTH.LOGIN_SUCCESS,
        data: {
            account,
            tokens: {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
            },
        },
    });
});

/**
 * POST /auth/logout
 */
const logout = asyncHandler(async (req, res) => {
    const refreshToken = req.body.refreshToken || req.cookies?.[config.cookie.refreshTokenName];

    // Always remove the client credential, even if token revocation later fails.
    clearRefreshTokenCookie(res);

    await authService.logout(refreshToken);

    ResponseHandler.success(res, {
        message: messages.AUTH.LOGOUT_SUCCESS,
    });
});

/**
 * POST /auth/refresh-token
 */
const refreshTokens = asyncHandler(async (req, res) => {
    const refreshToken = req.body.refreshToken || req.cookies?.[config.cookie.refreshTokenName];
    const {
        accessToken,
        refreshToken: newRefreshToken,
        account,
    } = await authService.refreshTokens(refreshToken);

    setRefreshTokenCookie(res, newRefreshToken);

    ResponseHandler.success(res, {
        message: messages.AUTH.TOKEN_REFRESHED,
        data: {
            account,
            accessToken,
            refreshToken: newRefreshToken,
        },
    });
});

/**
 * POST /auth/activation/request-otp
 */
const requestActivationOtp = asyncHandler(async (req, res) => {
    await verificationService.requestOtp(req.body.email, VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION);
    ResponseHandler.success(res, { message: messages.AUTH.OTP_SENT });
});

/**
 * POST /auth/activation/verify-otp
 */
const verifyActivationOtp = asyncHandler(async (req, res) => {
    const actionToken = await verificationService.verifyOtp(
        req.body.email,
        req.body.code,
        VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION,
    );
    ResponseHandler.success(res, {
        message: messages.AUTH.OTP_VERIFIED,
        data: { actionToken },
    });
});

/**
 * POST /auth/activation/complete
 */
const activateAccount = asyncHandler(async (req, res) => {
    await verificationService.activateAccount(req.body);
    ResponseHandler.success(res, { message: messages.AUTH.ACTIVATION_SUCCESS });
});

/**
 * POST /auth/forgot-password/request-otp
 */
const requestPasswordResetOtp = asyncHandler(async (req, res) => {
    await verificationService.requestOtp(req.body.email, VERIFICATION_PURPOSE.PASSWORD_RESET);
    ResponseHandler.success(res, { message: messages.AUTH.OTP_SENT });
});

/**
 * POST /auth/forgot-password/verify-otp
 */
const verifyPasswordResetOtp = asyncHandler(async (req, res) => {
    const actionToken = await verificationService.verifyOtp(
        req.body.email,
        req.body.code,
        VERIFICATION_PURPOSE.PASSWORD_RESET,
    );
    ResponseHandler.success(res, {
        message: messages.AUTH.OTP_VERIFIED,
        data: { actionToken },
    });
});

/**
 * POST /auth/forgot-password/reset
 */
const resetPassword = asyncHandler(async (req, res) => {
    await verificationService.resetPassword(req.body);
    ResponseHandler.success(res, { message: messages.AUTH.PASSWORD_RESET_SUCCESS });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

module.exports = {
    login,
    logout,
    refreshTokens,
    requestActivationOtp,
    verifyActivationOtp,
    activateAccount,
    requestPasswordResetOtp,
    verifyPasswordResetOtp,
    resetPassword,
};
