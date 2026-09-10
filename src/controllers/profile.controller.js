const { profileService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.getProfile(req.user.id);

    ResponseHandler.success(res, {
        message: messages.PROFILE.FETCH_SUCCESS,
        data: profile,
    });
});

const updateProfile = asyncHandler(async (req, res) => {
    const profile = await profileService.updateProfile(req.user.id, req.body);

    ResponseHandler.success(res, {
        message: messages.PROFILE.UPDATE_SUCCESS,
        data: profile,
    });
});

const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    await profileService.changePassword(req.user.id, currentPassword, newPassword);

    ResponseHandler.success(res, {
        message: messages.PROFILE.PASSWORD_CHANGE_SUCCESS,
    });
});

module.exports = {
    getProfile,
    updateProfile,
    changePassword,
};
