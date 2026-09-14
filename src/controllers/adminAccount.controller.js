const { adminAccountService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

const getListAccount = asyncHandler(async (req, res) => {
    const { accounts, meta } = await adminAccountService.getListAccount(req.query);

    ResponseHandler.paginated(res, {
        message: messages.ACCOUNT.LIST_FETCHED,
        data: accounts,
        meta,
    });
});

const getAccount = asyncHandler(async (req, res) => {
    const account = await adminAccountService.getAccountById(req.params.accountId);

    ResponseHandler.success(res, {
        message: messages.ACCOUNT.FETCHED,
        data: account,
    });
});

const createAccount = asyncHandler(async (req, res) => {
    const account = await adminAccountService.createAccount(req.body, req.account.id);

    ResponseHandler.created(res, {
        message: messages.ACCOUNT.CREATED,
        data: account,
    });
});

const resendActivation = asyncHandler(async (req, res) => {
    const result = await adminAccountService.resendActivation(req.params.accountId);

    ResponseHandler.success(res, {
        message: messages.ACCOUNT.ACTIVATION_EMAIL_SENT,
        data: result,
    });
});

const updateAccountStatus = asyncHandler(async (req, res) => {
    const account = await adminAccountService.updateAccountStatus(
        req.params.accountId,
        req.body,
        req.account.id,
    );

    ResponseHandler.success(res, {
        message: messages.ACCOUNT.STATUS_UPDATED,
        data: account,
    });
});

module.exports = {
    getListAccount,
    getAccount,
    createAccount,
    resendActivation,
    updateAccountStatus,
};
