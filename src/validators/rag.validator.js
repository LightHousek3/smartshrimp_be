const Joi = require('joi');
const uuid = () => Joi.string().uuid({ version: 'uuidv4' });
const pagination = { page: Joi.number().integer().min(1).max(100000).default(1), limit: Joi.number().integer().min(1).max(50).default(20) };
module.exports = {
    askQuestion: {
        body: Joi.object({
            question: Joi.string().trim().min(1).max(2000).required(),
            seasonId: uuid(), conversationId: uuid(), topK: Joi.number().integer().min(1).max(20),
        }).or('seasonId', 'conversationId'),
    },
    listConversations: { query: Joi.object({ ...pagination, seasonId: uuid().required() }) },
    getConversation: { params: Joi.object({ conversationId: uuid().required() }), query: Joi.object(pagination) },
    saveFeedback: {
        params: Joi.object({ queryId: uuid().required() }),
        body: Joi.object({ rating: Joi.number().integer().min(1).max(5).required(), comment: Joi.string().trim().max(2000).allow('', null) }),
    },
};
