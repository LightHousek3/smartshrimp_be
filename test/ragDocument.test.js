jest.mock('../src/config', () => ({
    rag: { serviceUrl: 'http://rag.test', internalApiKey: 'test-key', ingestionTimeoutMs: 300000, timeoutMs: 60000 },
}));
jest.mock('../src/config/prisma', () => ({
    ragDocument: {
        findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(),
        groupBy: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(),
    },
    $transaction: jest.fn((queries) => Promise.all(queries)),
}));
jest.mock('../src/services/ragStorage.service', () => ({ download: jest.fn(), verifyUpload: jest.fn() }));
jest.mock('axios', () => ({ post: jest.fn(), delete: jest.fn() }));

const { createHash } = require('node:crypto');
const prisma = require('../src/config/prisma');
const storage = require('../src/services/ragStorage.service');
const axios = require('axios');
const service = require('../src/services/ragDocument.service');
const ragClient = require('../src/services/ragClient.service');
const validator = require('../src/validators/ragDocument.validator');
const { RAG_DOCUMENT_STATUS: STATUS, RAG_DOCUMENT_CATEGORIES } = require('../src/constants');
const id = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
    jest.clearAllMocks();
    prisma.ragDocument.updateMany.mockResolvedValue({ count: 1 });
    prisma.ragDocument.findMany.mockResolvedValue([]);
    storage.verifyUpload.mockReturnValue(true);
});

describe('document request contract', () => {
    test.each(Object.values(STATUS))('accepts status %s', (status) => {
        expect(validator.list.query.validate({ status }).error).toBeUndefined();
    });
    test.each(['ready', 'UNKNOWN', ''])('rejects invalid status %s', (status) => {
        expect(validator.list.query.validate({ status }).error).toBeDefined();
    });
    test.each([...RAG_DOCUMENT_CATEGORIES, 'khác'])('accepts category %s on reads and writes', (category) => {
        const expected = category === 'khác' ? 'Khác' : category;
        expect(validator.list.query.validate({ category }).value.category).toBe(expected);
        const result = validator.update.body.validate({ category });
        expect(result.error).toBeUndefined();
        expect(result.value.category).toBe(expected);
    });
    test('rejects free-form category, permits null/empty to clear category', () => {
        expect(validator.update.body.validate({ category: 'unknown' }).error).toBeDefined();
        for (const category of [null, '']) expect(validator.update.body.validate({ category }).error).toBeUndefined();
    });
    test('normalizes the legacy category after trimming on upload', () => {
        const result = validator.createUploadIntent.body.validate({
            title: 'Shrimp', category: ' khác ', originalFilename: 'shrimp.txt', fileSize: 1, fileHash: 'a'.repeat(64),
        });
        expect(result.error).toBeUndefined();
        expect(result.value.category).toBe('Khác');
    });
});

describe('document lifecycle', () => {
    test('lists both category spellings and exposes canonical category without storage internals', async () => {
        prisma.ragDocument.findMany.mockResolvedValue([{ id, category: 'khác', status: STATUS.READY, storageKey: 'private', fileHash: 'private' }]);
        prisma.ragDocument.count.mockResolvedValue(1);
        prisma.ragDocument.groupBy.mockResolvedValue([{ status: STATUS.READY, _count: { id: 1 } }]);
        const result = await service.listDocuments({ category: 'Khác' });
        expect(prisma.ragDocument.findMany.mock.calls[0][0].where.category).toEqual({ in: ['khác', 'Khác'] });
        expect(result.data[0]).toMatchObject({ category: 'Khác', status: 'READY' });
        expect(result.data[0]).not.toHaveProperty('storageKey');
        expect(result.data[0]).not.toHaveProperty('fileHash');
        expect(result.meta.counts).toEqual({ READY: 1 });
    });
    test('repeated upload confirmation does not enqueue another attempt', async () => {
        prisma.ragDocument.findUnique.mockResolvedValue({ id, status: STATUS.READY, uploadedBy: 'admin' });
        await service.completeUpload(id, {}, 'admin');
        expect(prisma.ragDocument.updateMany).not.toHaveBeenCalled();
    });
    test('rejects another admin and expired upload before queueing', async () => {
        prisma.ragDocument.findUnique.mockResolvedValue({ id, status: STATUS.UPLOADING, uploadedBy: 'owner', nextAttemptAt: new Date(0) });
        await expect(service.completeUpload(id, {}, 'other')).rejects.toMatchObject({ statusCode: 403 });
        await expect(service.completeUpload(id, {}, 'owner')).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.ragDocument.updateMany).not.toHaveBeenCalled();
    });
    test('claims and completes ingestion with UUID/attempt fencing', async () => {
        const buffer = Buffer.from('Shrimp source');
        prisma.ragDocument.findFirst.mockResolvedValue({
            id, status: STATUS.PENDING, jobAttempts: 0, nextAttemptAt: new Date(0),
            originalFilename: 'shrimp.txt', title: 'Shrimp', fileSize: buffer.length,
            fileHash: createHash('sha256').update(buffer).digest('hex'), storageKey: 'source',
        });
        storage.download.mockResolvedValue(buffer);
        axios.post.mockResolvedValue({ data: { document_id: id, attempt: 1, chunks_count: 2 } });
        await service.processNext();
        expect(axios.post).toHaveBeenCalledWith(`http://rag.test/v1/documents/${id}/ingest`, buffer, expect.objectContaining({
            params: { filename: 'shrimp.txt', title: 'Shrimp', attempt: 1 },
        }));
        expect(prisma.ragDocument.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: { id, jobAttempts: 1, status: STATUS.PROCESSING },
            data: expect.objectContaining({ status: STATUS.READY, chunkCount: 2 }),
        }));
    });
    test('lost claim does not dispatch ingestion or deletion', async () => {
        prisma.ragDocument.findFirst.mockResolvedValue({ id, status: STATUS.PENDING, jobAttempts: 0, nextAttemptAt: new Date(0) });
        prisma.ragDocument.updateMany.mockResolvedValue({ count: 0 });
        await service.processNext();
        expect(storage.download).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
        expect(axios.delete).not.toHaveBeenCalled();
    });
});

test.each([{ documents: [] }, { documents: [{ id, jobAttempts: 2 }] }])('chat preserves exact ready/active eligibility: %j', async ({ documents }) => {
    prisma.ragDocument.findMany.mockResolvedValue(documents);
    axios.post.mockResolvedValue({ data: { answer: 'Answer', query_status: 'no_source', retrieved_chunks: [], top_similarity: null, model_version: null, processing_time_ms: 1 } });
    await ragClient.ask({ accountId: id, question: 'Shrimp?' });
    expect(prisma.ragDocument.findMany).toHaveBeenCalledWith({ where: { status: STATUS.READY, isActive: true }, select: { id: true, jobAttempts: true } });
    expect(axios.post.mock.calls[0][1].eligible_documents).toEqual(documents.map((doc) => ({ document_id: doc.id, attempt: doc.jobAttempts })));
});
