const { profileService } = require('../services');
const { asyncHandler, ResponseHandler, setRefreshTokenCookie } = require('../utils');
const { messages } = require('../constants');

const getProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.getProfile(req.account.id);

    ResponseHandler.success(res, {
        message: messages.PROFILE.FETCH_SUCCESS,
        data: profile,
    });
});

const updateProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.updateProfile(req.account.id, req.body);

    ResponseHandler.success(res, {
        message: messages.PROFILE.UPDATE_SUCCESS,
        data: profile,
    });
});

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
