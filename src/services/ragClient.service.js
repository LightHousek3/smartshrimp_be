const axios = require('axios');
const Joi = require('joi');
const config = require('../config');
const prisma = require('../config/prisma');
const { messages, RAG_DOCUMENT_STATUS } = require('../constants');

const responseSchema = Joi.object({
    answer: Joi.string().trim().min(1).allow(null).required(),
    query_status: Joi.string().valid('answered', 'no_source', 'low_match', 'error').required(),
    retrieved_chunks: Joi.array().items(Joi.object({
        source_file: Joi.string().required(), chunk_index: Joi.number().integer().min(0).required(),
        content: Joi.string().required(), similarity: Joi.number().min(0).max(1).required(), metadata: Joi.object().unknown(true),
    })).required(),
    top_similarity: Joi.number().min(0).max(1).allow(null).required(),
    model_version: Joi.string().max(100).allow(null).required(),
    processing_time_ms: Joi.number().integer().min(0).max(2147483647).allow(null).required(),
});

const ask = async ({ accountId, conversationId, seasonId, question, topK }) => {
    const started = Date.now();
    try {
        if (!config.rag.serviceUrl || !config.rag.internalApiKey) throw new Error('RAG_NOT_CONFIGURED');
        // SQL is the authority for eligibility; disabled/deleting docs never enter retrieval.
        const documents = await prisma.ragDocument.findMany({ where: { status: RAG_DOCUMENT_STATUS.READY, isActive: true }, select: { id: true, jobAttempts: true } });
        const { data } = await axios.post(`${config.rag.serviceUrl}/v1/chat`, {
            user_id: accountId, conversation_id: conversationId, season_id: seasonId, question,
            ...(topK !== undefined && { top_k: topK }),
            eligible_documents: documents.map((doc) => ({ document_id: doc.id, attempt: doc.jobAttempts })),
        }, { timeout: config.rag.timeoutMs, headers: { 'X-Internal-Key': config.rag.internalApiKey } });
        const { error, value } = responseSchema.validate(data);
        if (error || (value.query_status !== 'error' && !value.answer)) throw new Error('RAG_INVALID_RESPONSE');
        return {
            answer: value.answer, queryStatus: value.query_status.toUpperCase(),
            retrievedChunks: value.retrieved_chunks, topSimilarity: value.top_similarity,
            modelVersion: value.model_version, processingTimeMs: value.processing_time_ms,
            ...(value.query_status === 'error' && { errorCode: 'RAG_ERROR', errorMessage: messages.RAG.UNAVAILABLE }),
        };
    } catch (error) {
        return {
            answer: null, queryStatus: 'ERROR', retrievedChunks: [], topSimilarity: null, modelVersion: null,
            processingTimeMs: Math.min(Date.now() - started, 2147483647),
            errorCode: error.code === 'ECONNABORTED' ? 'RAG_TIMEOUT' : 'RAG_UNAVAILABLE',
            errorMessage: messages.RAG.UNAVAILABLE,
        };
    }
};
module.exports = { ask };
