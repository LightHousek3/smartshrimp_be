const { ragDocumentService: service } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');

/**
 * POST /admin/rag/documents/upload-intents
 */
const createUploadIntent = asyncHandler(async (req, res) => {
    const data = await service.createUploadIntent(req.body, req.account.id);
    ResponseHandler.success(res, { statusCode: 201, data });
});

/**
 * POST /admin/rag/documents/:id/complete-upload
 */
const completeUpload = asyncHandler(async (req, res) => {
    const data = await service.completeUpload(req.params.id, req.body, req.account.id);
    ResponseHandler.success(res, { statusCode: 202, message: 'Đã nhận tài liệu. AI đang kiểm tra và xử lý.', data });
});

/**
 * POST /admin/rag/documents/:id/reupload-intents
 */
const createReuploadIntent = asyncHandler(async (req, res) => {
    const data = await service.createReuploadIntent(req.params.id, req.body);
    ResponseHandler.success(res, { statusCode: 201, data });
});

/**
 * POST /admin/rag/documents/:id/complete-reupload
 */
const completeReupload = asyncHandler(async (req, res) => {
    const data = await service.completeReupload(req.params.id, req.body);
    ResponseHandler.success(res, { statusCode: 202, message: 'Đã nhận lại file gốc. AI đang kiểm tra và xử lý.', data });
});

/**
 * POST /admin/rag/documents/:id/cancel-upload
 */
const cancelUpload = asyncHandler(async (req, res) => {
    await service.cancelUpload(req.params.id, req.account.id);
    ResponseHandler.noContent(res);
});

/**
 * GET /admin/rag/documents
 */
const listDocuments = asyncHandler(async (req, res) => ResponseHandler.paginated(res, await service.listDocuments(req.query)));

/**
 * GET /admin/rag/documents/:id
 */
const getDocument = asyncHandler(async (req, res) => ResponseHandler.success(res, { data: await service.getDocument(req.params.id) }));

/**
 * PATCH /admin/rag/documents/:id
 */
const updateDocument = asyncHandler(async (req, res) => ResponseHandler.success(res, { data: await service.updateDocument(req.params.id, req.body) }));

/**
 * POST /admin/rag/documents/:id/retry
 */
const retryDocument = asyncHandler(async (req, res) => ResponseHandler.success(res, { statusCode: 202, data: await service.retryDocument(req.params.id), message: 'Đã đưa tài liệu vào hàng đợi xử lý lại.' }));

/**
 * GET /admin/rag/documents/:id/file
 */
const downloadDocument = asyncHandler(async (req, res) => {
    const file = await service.downloadDocument(req.params.id);
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(file.buffer);
});

module.exports = { createUploadIntent, completeUpload, createReuploadIntent, completeReupload, cancelUpload, listDocuments, getDocument, updateDocument, retryDocument, downloadDocument };
