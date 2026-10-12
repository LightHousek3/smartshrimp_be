const express = require('express');
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { ragController: controller } = require('../controllers');
const { ragValidator: validator } = require('../validators');
const router = express.Router();
router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   POST /api/v1/me/rag/queries
 * @desc    Ask a RAG question for an assigned season and save the answer in a conversation
 * @access  Technician
 */
router.post('/queries', validate(validator.askQuestion), controller.askQuestion);

/**
 * @route   GET /api/v1/me/rag/conversations
 * @desc    List RAG conversations belonging to the authenticated Technician
 * @access  Technician
 */
router.get('/conversations', validate(validator.listConversations), controller.listConversations);

/**
 * @route   GET /api/v1/me/rag/conversations/:conversationId
 * @desc    Get an owned RAG conversation and its paginated questions and answers
 * @access  Technician
 */
router.get('/conversations/:conversationId', validate(validator.getConversation), controller.getConversation);

/**
 * @route   PUT /api/v1/me/rag/queries/:queryId/feedback
 * @desc    Create or update feedback on an answer in an owned RAG conversation
 * @access  Technician
 */
router.put('/queries/:queryId/feedback', validate(validator.saveFeedback), controller.saveFeedback);
module.exports = router;
