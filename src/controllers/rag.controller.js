const service = require('../services/rag.service');
const { asyncHandler, ResponseHandler } = require('../utils');
const { MESSAGES } = require('../constants/rag');
const askQuestion = asyncHandler(async (req, res) => {
    const data = await service.askQuestion(req.account.id, req.body);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.created(res, { message: MESSAGES.QUESTION_SAVED, data });
});
const listConversations = asyncHandler(async (req, res) => {
    const { conversations, meta } = await service.listConversations(req.account.id, req.query);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.paginated(res, { message: MESSAGES.LIST_FETCHED, data: conversations, meta });
});
const getConversation = asyncHandler(async (req, res) => {
    const { conversation, meta } = await service.getConversation(req.account.id, req.params.conversationId, req.query);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.success(res, { message: MESSAGES.CONVERSATION_FETCHED, data: conversation, meta });
});
const saveFeedback = asyncHandler(async (req, res) => {
    const data = await service.saveFeedback(req.account.id, req.params.queryId, req.body);
    ResponseHandler.success(res, { message: MESSAGES.FEEDBACK_SAVED, data });
});
module.exports = { askQuestion, listConversations, getConversation, saveFeedback };
