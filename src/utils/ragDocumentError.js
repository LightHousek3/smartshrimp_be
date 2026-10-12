const ApiError = require('./ApiError');
const { RAG_DOCUMENT_ERRORS } = require('../constants');

const createDocumentError = (errorCode) => {
    const { status, message } = RAG_DOCUMENT_ERRORS[errorCode];
    return Object.assign(new ApiError(status, message), { errorCode });
};

// Persist canonical messages in the existing column; derive a stable API code without a schema change.
const getDocumentErrorCode = (message) => Object.keys(RAG_DOCUMENT_ERRORS)
    .find((code) => RAG_DOCUMENT_ERRORS[code].message === message) || null;

module.exports = { createDocumentError, getDocumentErrorCode };
