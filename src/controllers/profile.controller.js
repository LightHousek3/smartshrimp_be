const { profileService } = require('../services');
const { asyncHandler, ResponseHandler, setRefreshTokenCookie } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /profile
 * Return only the authenticated account’s public profile; never accept an account ID from input.
 */
const getProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.getProfile(req.account.id);

    ResponseHandler.success(res, {
        message: messages.PROFILE.FETCH_SUCCESS,
        data: profile,
    });
});

/**
 * PATCH /profile
 * Forward the validated editable fields and the authenticated account ID.
 */
const updateProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.updateProfile(req.account.id, req.body);

    ResponseHandler.success(res, {
        message: messages.PROFILE.UPDATE_SUCCESS,
        data: profile,
    });
});

/**
 * PATCH /profile/password
 * Return the renewed current session and update its cookie after atomic password rotation.
 */
const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword, deviceId } = req.body;
    const { account, tokens } = await profileService.changePassword(
        req.account.id,
        currentPassword,
        newPassword,
        deviceId,
    );

    setRefreshTokenCookie(res, tokens.refreshToken);

    ResponseHandler.success(res, {
        message: messages.PROFILE.PASSWORD_CHANGE_SUCCESS,
        data: { account, tokens },
    });
});

module.exports = {
    getProfile,
    updateProfile,
    changePassword,
};
