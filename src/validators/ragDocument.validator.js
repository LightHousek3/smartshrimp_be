const Joi = require('joi');
const path = require('node:path');
const { RAG_DOCUMENT_STATUS, RAG_DOCUMENT_CATEGORIES, RAG_DOCUMENT_EXTENSIONS, RAG_DOCUMENT_MAX_FILE_BYTES, messages } = require('../constants');
const params = Joi.object({ id: Joi.string().uuid().required() });
const fields = {
    title: Joi.string().trim().min(1).max(255),
    description: Joi.string().trim().max(1000).allow('', null),
    category: Joi.string().trim().replace(/^khác$/, 'Khác').valid(...RAG_DOCUMENT_CATEGORIES).allow('', null),
};
const fileFields = {
    originalFilename: Joi.string().required().custom((name, helpers) => {
        if (!name.trim() || Array.from(name).length > 500 || name.includes('\uFFFD')
            || Array.from(name).some((char) => '/\\'.includes(char) || char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) {
            return helpers.message({ custom: messages.RAG_DOCUMENT.INVALID_NAME });
        }
        if (!RAG_DOCUMENT_EXTENSIONS.includes(path.extname(name).toLowerCase())) return helpers.message({ custom: messages.RAG_DOCUMENT.UNSUPPORTED });
        return name;
    }),
    fileSize: Joi.number().integer().min(1).max(RAG_DOCUMENT_MAX_FILE_BYTES).required(),
    fileHash: Joi.string().pattern(/^[a-f0-9]{64}$/).required(),
};
module.exports = {
    createUploadIntent: { body: Joi.object({ ...fields, ...fileFields, title: fields.title.required() }) },
    createReuploadIntent: { params, body: Joi.object(fileFields) },
    completeUpload: { params, body: Joi.object({
        publicId: Joi.string().max(500).required(),
        version: Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER).required(),
        signature: Joi.string().pattern(/^[a-f0-9]{40}$/).required(),
    }) },
    list: { query: Joi.object({
        q: Joi.string().trim().max(255).allow(''), category: fields.category,
        status: Joi.string().valid(...Object.values(RAG_DOCUMENT_STATUS)),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(10),
    }) },
    byId: { params },
    update: { params, body: Joi.object({ ...fields, isActive: Joi.boolean().strict() }).min(1) },
};
