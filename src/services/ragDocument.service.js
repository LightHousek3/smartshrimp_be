const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const axios = require('axios');
const prisma = require('../config/prisma');
const config = require('../config');
const storage = require('./ragStorage.service');
const { ApiError } = require('../utils');
const { createDocumentError, getDocumentErrorCode } = require('../utils/ragDocumentError');
const { RAG_DOCUMENT_STATUS, RAG_DOCUMENT_MAX_FILE_BYTES, RAG_DOCUMENT_CATEGORIES, messages, RAG_UPLOAD_SIGNATURE_TTL_MS, RAG_UPLOAD_CLEANUP_DELAY_MS } = require('../constants');

const include = { uploader: { select: { id: true, fullName: true } } };
const CONFIRMED_STATUSES = [RAG_DOCUMENT_STATUS.PENDING, RAG_DOCUMENT_STATUS.PROCESSING, RAG_DOCUMENT_STATUS.READY, RAG_DOCUMENT_STATUS.FAILED];
const publicDocument = ({ storageKey, storageProvider, storageResourceType, fileHash, nextAttemptAt, ...row }) => ({
    ...row, category: row.category === 'khác' ? 'Khác' : row.category, errorCode: getDocumentErrorCode(row.errorMessage) || (row.status === RAG_DOCUMENT_STATUS.FAILED ? 'RAG_INGESTION_FAILED' : null),
});

/**
 * Get document details with uploader information and a stable error code.
 * Internal storage locators, hashes and worker scheduling fields are omitted.
 */
const getDocument = async (id) => {
    const row = await prisma.ragDocument.findUnique({ where: { id }, include });
    if (!row) throw ApiError.notFound('Không tìm thấy tài liệu.');
    return publicDocument(row);
};

/**
 * Identify an allowed document MIME type from its extension and file bytes.
 * Reject unsupported signatures, empty text, invalid UTF-8 and binary text.
 */
const sniff = (file) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const bytes = file.buffer;
    if (extension === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
    if (extension === '.docx' && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (['.txt', '.md'].includes(extension)) {
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const binary = Array.from(text).some((char) => char.codePointAt(0) < 32 && !'\t\n\r'.includes(char));
            if (text.trim() && !binary) return extension === '.md' ? 'text/markdown' : 'text/plain';
        } catch { /* Reject binary files renamed to text. */ }
    }
    throw ApiError.badRequest(messages.RAG_DOCUMENT.INVALID_CONTENT);
};

/**
 * Reserve a document and sign a direct browser upload to Cloudinary.
 * Keep its storage locator and cleanup deadline so abandoned uploads can
 * be removed after the upload signature expires.
 */
const createUploadIntent = async (input, accountId) => {
    storage.ensureConfigured();
    const id = randomUUID();
    const storageKey = `smartshrimp/rag/${id}${path.extname(input.originalFilename).toLowerCase()}`;
    const upload = storage.createUploadIntent(storageKey);
    // Keep the locator even when the browser closes before confirming the upload.
    await prisma.ragDocument.create({ data: {
        id, status: RAG_DOCUMENT_STATUS.UPLOADING, title: input.title, description: input.description || null, category: input.category || null,
        originalFilename: input.originalFilename, storageKey, mimeType: 'application/octet-stream', fileSize: input.fileSize,
        fileHash: input.fileHash, uploadedBy: accountId,
        nextAttemptAt: new Date(Date.now() + RAG_UPLOAD_CLEANUP_DELAY_MS),
    } });
    return { id, upload, expiresAt: new Date(upload.fields.timestamp * 1000 + RAG_UPLOAD_SIGNATURE_TTL_MS).toISOString() };
};

/**
 * Verify the uploader and signed upload receipt before queueing ingestion.
 * Confirmation is idempotent for documents already accepted; an expired
 * or cancelled upload cannot be queued again.
 */
const completeUpload = async (id, receipt, accountId) => {
    const row = await prisma.ragDocument.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('Không tìm thấy phiên tải lên.');
    if (row.uploadedBy !== accountId) throw ApiError.forbidden('Phiên tải lên thuộc quản trị viên khác.');
    if (!storage.verifyUpload(row.storageKey, receipt)) throw ApiError.badRequest('Không thể xác thực kết quả tải lên Cloudinary.');
    // A repeated confirmation after a lost response must not enqueue a second job.
    if (CONFIRMED_STATUSES.includes(row.status)) return getDocument(id);
    if (row.status !== RAG_DOCUMENT_STATUS.UPLOADING || row.nextAttemptAt <= new Date()) throw ApiError.conflict('Phiên tải lên đã hết hạn hoặc bị hủy.');
    const changed = await prisma.ragDocument.updateMany({ where: { id, status: RAG_DOCUMENT_STATUS.UPLOADING, nextAttemptAt: { gt: new Date() } },
        data: { status: RAG_DOCUMENT_STATUS.PENDING, errorMessage: null, nextAttemptAt: new Date() } });
    if (!changed.count) {
        const current = await getDocument(id);
        if (CONFIRMED_STATUSES.includes(current.status)) return current;
        throw ApiError.conflict('Phiên tải lên vừa thay đổi. Vui lòng làm mới.');
    }
    return getDocument(id);
};

/**
 * Sign an upload to restore a failed document whose source file is missing.
 * The hash, size and extension must match the original file, and the
 * existing storage locator is reused without creating a new document.
 */
const createReuploadIntent = async (id, input) => {
    const row = await prisma.ragDocument.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('Không tìm thấy tài liệu.');
    if (row.status !== RAG_DOCUMENT_STATUS.FAILED || getDocumentErrorCode(row.errorMessage) !== 'RAG_SOURCE_MISSING') {
        throw ApiError.conflict('Chỉ tải lại file cho tài liệu bị mất file gốc.');
    }
    if (input.fileHash !== row.fileHash || input.fileSize !== row.fileSize
        || path.extname(input.originalFilename).toLowerCase() !== path.extname(row.originalFilename).toLowerCase()) {
        throw createDocumentError('RAG_REUPLOAD_FILE_MISMATCH');
    }
    // Restore the immutable source at its existing locator. An abandoned restore must never delete the document.
    const upload = storage.createUploadIntent(row.storageKey);
    return { id, originalFilename: row.originalFilename, upload,
        expiresAt: new Date(upload.fields.timestamp * 1000 + RAG_UPLOAD_SIGNATURE_TTL_MS).toISOString() };
};

/**
 * Verify a restored source receipt and queue the existing document again.
 * Repeated confirmations return the accepted document; conditional writes
 * prevent overwriting a concurrent document or worker update.
 */
const completeReupload = async (id, receipt) => {
    const row = await prisma.ragDocument.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound('Không tìm thấy tài liệu.');
    if (!storage.verifyUpload(row.storageKey, receipt)) throw ApiError.badRequest('Không thể xác thực kết quả tải lên Cloudinary.');
    const missing = getDocumentErrorCode(row.errorMessage) === 'RAG_SOURCE_MISSING';
    if (CONFIRMED_STATUSES.includes(row.status) && !missing) return getDocument(id);
    if (row.status !== RAG_DOCUMENT_STATUS.FAILED || !missing) throw ApiError.conflict('Tài liệu không ở trạng thái chờ tải lại file gốc.');
    const changed = await prisma.ragDocument.updateMany({
        where: { id, status: RAG_DOCUMENT_STATUS.FAILED, errorMessage: row.errorMessage, updatedAt: row.updatedAt, jobAttempts: row.jobAttempts },
        data: { status: RAG_DOCUMENT_STATUS.PENDING, errorMessage: null, nextAttemptAt: new Date(), processingStartedAt: null },
    });
    if (!changed.count) {
        const current = await getDocument(id);
        if (CONFIRMED_STATUSES.includes(current.status) && current.errorCode !== 'RAG_SOURCE_MISSING') return current;
        throw ApiError.conflict('Tài liệu vừa thay đổi. Vui lòng làm mới.');
    }
    return getDocument(id);
};

/**
 * Cancel an upload owned by the requesting admin and schedule cleanup.
 * Missing or already confirmed uploads need no state change; cleanup waits
 * until the signature validity and in-flight upload grace period have passed.
 */
const cancelUpload = async (id, accountId) => {
    const row = await prisma.ragDocument.findUnique({ where: { id } });
    if (!row) return;
    if (row.uploadedBy !== accountId) throw ApiError.forbidden('Phiên tải lên thuộc quản trị viên khác.');
    await prisma.ragDocument.updateMany({ where: { id, status: RAG_DOCUMENT_STATUS.UPLOADING }, data: {
        status: RAG_DOCUMENT_STATUS.DELETING, isActive: false, errorMessage: 'Dọn phiên tải lên bị hủy.',
        nextAttemptAt: new Date(Math.max(Date.now(), row.createdAt.getTime() + RAG_UPLOAD_CLEANUP_DELAY_MS)),
    } });
};

/**
 * List documents with search, category and status filters and pagination.
 * Return global status counts and upload rules alongside public document data.
 */
const listDocuments = async ({ q, status, category, page = 1, limit = 10 }) => {
    const where = {
        ...(q && { OR: [{ title: { contains: q, mode: 'insensitive' } }, { originalFilename: { contains: q, mode: 'insensitive' } }] }),
        ...(status && { status }), ...(category && { category: ['khác', 'Khác'].includes(category) ? { in: ['khác', 'Khác'] } : category }),
    };
    const [rows, totalResults, groups] = await prisma.$transaction([
        prisma.ragDocument.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
        prisma.ragDocument.count({ where }),
        prisma.ragDocument.groupBy({ by: ['status'], _count: { id: true } }),
    ]);
    const counts = Object.fromEntries(groups.map((row) => [row.status, row._count.id]));
    return { data: rows.map(publicDocument), meta: {
        page, limit, totalResults, totalPages: Math.ceil(totalResults / limit), hasNextPage: page * limit < totalResults,
        counts, categories: RAG_DOCUMENT_CATEGORIES,
        upload: { maxFileBytes: RAG_DOCUMENT_MAX_FILE_BYTES, extensions: ['.pdf', '.docx', '.txt', '.md'] },
    } };
};

/**
 * Update document metadata or change retrieval availability for ready documents.
 * Uploading or deleting documents cannot be edited, and conditional writes
 * reject changes made against an outdated document version.
 */
const updateDocument = async (id, input) => {
    const row = await getDocument(id);
    if ([RAG_DOCUMENT_STATUS.UPLOADING, RAG_DOCUMENT_STATUS.DELETING, RAG_DOCUMENT_STATUS.DELETE_FAILED].includes(row.status)) throw ApiError.conflict('Tài liệu đang tải lên hoặc chờ xóa.');
    if (input.isActive !== undefined && row.status !== RAG_DOCUMENT_STATUS.READY) throw ApiError.conflict('Chỉ bật/tắt tài liệu đã sẵn sàng.');
    const data = { ...input };
    for (const key of ['category', 'description']) if (data[key] === '') data[key] = null;
    const changed = await prisma.ragDocument.updateMany({ where: { id, status: row.status, updatedAt: row.updatedAt }, data });
    if (!changed.count) throw ApiError.conflict('Tài liệu vừa thay đổi. Vui lòng làm mới.');
    return getDocument(id);
};

/**
 * Queue a failed document for ingestion again without creating a new document.
 * A missing source file must be restored before ingestion can be retried.
 */
const retryDocument = async (id) => {
    const row = await getDocument(id);
    if (row.errorCode === 'RAG_SOURCE_MISSING') throw createDocumentError('RAG_SOURCE_MISSING');
    const changed = await prisma.ragDocument.updateMany({ where: { id, status: RAG_DOCUMENT_STATUS.FAILED }, data: { status: RAG_DOCUMENT_STATUS.PENDING, errorMessage: null, nextAttemptAt: new Date() } });
    if (!changed.count) throw ApiError.conflict('Chỉ thử lại tài liệu xử lý thất bại.');
    return getDocument(id);
};

/**
 * Download the original source file with its filename and MIME type.
 * When Cloudinary confirms the source is missing, mark an eligible document
 * as failed only if its state has not changed during the download.
 */
const downloadDocument = async (id) => {
    const row = await prisma.ragDocument.findUnique({ where: { id } });
    if (!row || [RAG_DOCUMENT_STATUS.DELETING, RAG_DOCUMENT_STATUS.DELETE_FAILED].includes(row.status)) throw ApiError.notFound('Không tìm thấy file.');
    try {
        return { buffer: await storage.download(row.storageKey), filename: row.originalFilename, mimeType: row.mimeType };
    } catch (error) {
        if (error.errorCode === 'RAG_SOURCE_MISSING' && [RAG_DOCUMENT_STATUS.READY, RAG_DOCUMENT_STATUS.FAILED, RAG_DOCUMENT_STATUS.PENDING].includes(row.status)) {
            // Fence against an upload or worker changing the document while the download was in flight.
            await prisma.ragDocument.updateMany({
                where: { id, status: row.status, updatedAt: row.updatedAt },
                data: { status: RAG_DOCUMENT_STATUS.FAILED, errorMessage: error.message, processingStartedAt: null },
            });
        }
        throw error;
    }
};
const internal = () => {
    if (!config.rag.serviceUrl || !config.rag.internalApiKey) throw new ApiError(503, messages.RAG_DOCUMENT.UNAVAILABLE);
    return { timeout: config.rag.ingestionTimeoutMs, maxRedirects: 0, headers: { 'X-Internal-Key': config.rag.internalApiKey } };
};

/**
 * Recover abandoned uploads and expired jobs, then claim one due document.
 * Validate source size, hash and content before ingestion, or clean up vectors
 * and storage for a deletion job. Conditional updates prevent stale attempts
 * from overwriting newer work; eligible transient failures are rescheduled.
 */
const processNext = async () => {
    const now = new Date();
    const leaseMs = config.rag.ingestionTimeoutMs + 180000;
    await prisma.ragDocument.updateMany({ where: { status: RAG_DOCUMENT_STATUS.UPLOADING, nextAttemptAt: { lt: now } },
        data: { status: RAG_DOCUMENT_STATUS.DELETING, isActive: false, errorMessage: 'Dọn phiên tải lên bị gián đoạn.', nextAttemptAt: now } });
    // Recover failed cleanup from older versions without a manual delete action.
    await prisma.ragDocument.updateMany({ where: { status: RAG_DOCUMENT_STATUS.DELETE_FAILED, nextAttemptAt: { lte: now } },
        data: { status: RAG_DOCUMENT_STATUS.DELETING, isActive: false, nextAttemptAt: now } });
    await prisma.ragDocument.updateMany({ where: { status: RAG_DOCUMENT_STATUS.PROCESSING, nextAttemptAt: { lt: now } },
        data: { status: RAG_DOCUMENT_STATUS.FAILED, errorMessage: createDocumentError('RAG_INGESTION_TIMEOUT').message, processingStartedAt: null } });
    const row = await prisma.ragDocument.findFirst({ where: { status: { in: [RAG_DOCUMENT_STATUS.PENDING, RAG_DOCUMENT_STATUS.DELETING] }, nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' } });
    if (!row) return;
    const deleting = row.status === RAG_DOCUMENT_STATUS.DELETING;
    const attempt = row.jobAttempts + 1;
    const claimed = await prisma.ragDocument.updateMany({ where: { id: row.id, status: row.status, jobAttempts: row.jobAttempts, nextAttemptAt: row.nextAttemptAt },
        data: { status: deleting ? RAG_DOCUMENT_STATUS.DELETING : RAG_DOCUMENT_STATUS.PROCESSING, jobAttempts: attempt, processingStartedAt: now, nextAttemptAt: new Date(Date.now() + leaseMs), errorMessage: null } });
    if (!claimed.count) return;
    const fence = { id: row.id, jobAttempts: attempt, status: deleting ? RAG_DOCUMENT_STATUS.DELETING : RAG_DOCUMENT_STATUS.PROCESSING };
    try {
        const options = internal();
        if (deleting) {
            await axios.delete(`${config.rag.serviceUrl}/v1/documents/${row.id}/vectors`, options);
            await storage.destroy(row.storageKey);
            await prisma.ragDocument.deleteMany({ where: fence });
            return;
        }
        const buffer = await storage.download(row.storageKey);
        if (buffer.length !== row.fileSize || buffer.length > RAG_DOCUMENT_MAX_FILE_BYTES || createHash('sha256').update(buffer).digest('hex') !== row.fileHash) {
            throw createDocumentError('RAG_INVALID_CONTENT');
        }
        let mimeType;
        try { mimeType = sniff({ originalname: row.originalFilename, buffer }); }
        catch { throw createDocumentError('RAG_INVALID_CONTENT'); }
        const { data } = await axios.post(`${config.rag.serviceUrl}/v1/documents/${row.id}/ingest`, buffer, {
            ...options, params: { filename: row.originalFilename, title: row.title, attempt },
            headers: { ...options.headers, 'Content-Type': 'application/octet-stream' }, maxBodyLength: RAG_DOCUMENT_MAX_FILE_BYTES,
        });
        if (data.document_id !== row.id || data.attempt !== attempt || !Number.isInteger(data.chunks_count) || data.chunks_count < 1) throw new Error('INVALID_INDEX_RESPONSE');
        await prisma.ragDocument.updateMany({ where: fence, data: { status: RAG_DOCUMENT_STATUS.READY, mimeType, chunkCount: data.chunks_count, indexedAt: new Date(), processingStartedAt: null, errorMessage: null } });
    } catch (error) {
        const timeout = ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) || error.response?.status === 504;
        const classified = error.errorCode ? error : createDocumentError(timeout ? 'RAG_INGESTION_TIMEOUT'
            : error.response?.status === 400 ? 'RAG_INVALID_CONTENT' : 'RAG_INGESTION_FAILED');
        const dispatchUnavailable = ['RAG_STORAGE_UNAVAILABLE', 'RAG_STORAGE_TIMEOUT'].includes(classified.errorCode)
            || !error.errorCode && !error.response && !timeout;
        const pending = !deleting && dispatchUnavailable && attempt < 3;
        await prisma.ragDocument.updateMany({ where: fence, data: {
            status: deleting ? RAG_DOCUMENT_STATUS.DELETING : pending ? RAG_DOCUMENT_STATUS.PENDING : RAG_DOCUMENT_STATUS.FAILED,
            nextAttemptAt: new Date(Date.now() + 30000), processingStartedAt: null,
            errorMessage: deleting ? 'Chưa dọn xong vectors hoặc file gốc. Hệ thống sẽ tự thử lại.'
                : classified.message,
        } });
    }
};
module.exports = { createUploadIntent, completeUpload, createReuploadIntent, completeReupload, cancelUpload, listDocuments, getDocument, updateDocument, retryDocument, downloadDocument, processNext, sniff };
