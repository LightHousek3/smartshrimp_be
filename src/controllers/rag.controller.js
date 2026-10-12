const { ragService: service } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * POST /me/rag/queries
 */
const askQuestion = asyncHandler(async (req, res) => {
    const data = await service.askQuestion(req.account.id, req.body);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.created(res, { message: messages.RAG.QUESTION_SAVED, data });
});

/**
 * GET /me/rag/conversations
 */
const listConversations = asyncHandler(async (req, res) => {
    const { conversations, meta } = await service.listConversations(req.account.id, req.query);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.paginated(res, { message: messages.RAG.LIST_FETCHED, data: conversations, meta });
});

/**
 * GET /me/rag/conversations/:conversationId
 */
const getConversation = asyncHandler(async (req, res) => {
    const { conversation, meta } = await service.getConversation(req.account.id, req.params.conversationId, req.query);
    res.set('Cache-Control', 'private, no-store');
    ResponseHandler.success(res, { message: messages.RAG.CONVERSATION_FETCHED, data: conversation, meta });
});

/**
 * PUT /me/rag/queries/:queryId/feedback
 */
const saveFeedback = asyncHandler(async (req, res) => {
    const data = await service.saveFeedback(req.account.id, req.params.queryId, req.body);
    ResponseHandler.success(res, { message: messages.RAG.FEEDBACK_SAVED, data });
});

module.exports = { askQuestion, listConversations, getConversation, saveFeedback };
