jest.mock('../src/config', () => ({ env: 'test' }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
jest.mock('../src/config/prisma', () => ({
    ragDocument: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(),
        findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    $transaction: jest.fn((queries) => Promise.all(queries)),
}));
jest.mock('../src/services/ragStorage.service', () => ({
    ensureConfigured: jest.fn(), createUploadIntent: jest.fn(),
}));
jest.mock('../src/services', () => ({ ragDocumentService: jest.requireActual('../src/services/ragDocument.service') }));
jest.mock('../src/controllers', () => ({ ragDocumentController: jest.requireActual('../src/controllers/ragDocument.controller') }));
jest.mock('../src/middlewares', () => ({
    validate: require('../src/middlewares/validate.middleware'),
    authenticate: (req, res, next) => { req.account = { id: 'admin' }; next(); },
    authorize: () => (req, res, next) => next(),
    writeLimiter: (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/prisma');
const storage = require('../src/services/ragStorage.service');
const { RAG_DOCUMENT_CATEGORIES, RAG_DOCUMENT_MAX_FILE_BYTES } = require('../src/constants');
const validator = require('../src/validators/ragDocument.validator');
const app = express();
const base = '/api/v1/admin/rag/documents';
const id = '11111111-1111-4111-8111-111111111111';
const upload = { title: 'Tài liệu', originalFilename: 'guide.txt', fileSize: 1, fileHash: 'a'.repeat(64) };
app.use(express.json());
app.use(base, require('../src/routes/adminRagDocument.route'));
app.use(require('../src/middlewares/error.middleware').errorHandler);
let row;

beforeEach(() => {
    jest.clearAllMocks();
    row = { id, title: 'Tài liệu', category: 'Kỹ thuật nuôi', description: 'Mô tả',
        status: 'READY', updatedAt: new Date('2026-01-01T00:00:00Z') };
    prisma.ragDocument.findUnique.mockImplementation(async () => ({ ...row }));
    prisma.ragDocument.updateMany.mockImplementation(async ({ data }) => {
        row = { ...row, ...data };
        return { count: 1 };
    });
    prisma.ragDocument.findMany.mockImplementation(async () => [{ ...row }]);
    prisma.ragDocument.count.mockResolvedValue(1);
    prisma.ragDocument.groupBy.mockResolvedValue([{ status: 'READY', _count: { id: 1 } }]);
    storage.createUploadIntent.mockReturnValue({ fields: { timestamp: 1700000000 } });
});

test.each([undefined, '', null, '   '])('upload category %j returns the required 400 message without reserving a document', async (category) => {
    const response = await request(app).post(`${base}/upload-intents`).send({ ...upload, category }).expect(400);
    expect(response.body).toMatchObject({ success: false, message: 'Vui lòng chọn danh mục.' });
    expect(storage.createUploadIntent).not.toHaveBeenCalled();
    expect(prisma.ragDocument.create).not.toHaveBeenCalled();
});

test.each([...RAG_DOCUMENT_CATEGORIES, ' khác '])('upload category %j reserves a canonical document', async (category) => {
    await request(app).post(`${base}/upload-intents`).send({ ...upload, category }).expect(201);
    expect(prisma.ragDocument.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        category: category.trim() === 'khác' ? 'Khác' : category,
    }) });
});

test('upload rejects categories outside the allowed set', async () => {
    await request(app).post(`${base}/upload-intents`).send({ ...upload, category: 'Tự đặt' }).expect(400);
    expect(prisma.ragDocument.create).not.toHaveBeenCalled();
});

test.each([undefined, '', null, '   '])('PATCH category %j preserves stored category and still clears description', async (category) => {
    const response = await request(app).patch(`${base}/${id}`).send({ category, title: 'Tên mới', description: '' }).expect(200);
    const write = prisma.ragDocument.updateMany.mock.calls[0][0];
    expect(write.data).toEqual({ title: 'Tên mới', description: null });
    expect(write.where).toEqual({ id, status: 'READY', updatedAt: new Date('2026-01-01T00:00:00Z') });
    expect(response.body.data).toMatchObject({ category: 'Kỹ thuật nuôi', title: 'Tên mới', description: null });
});

test.each([null, ''])('PATCH only an empty category %j cannot erase the stored category', async (category) => {
    const response = await request(app).patch(`${base}/${id}`).send({ category }).expect(200);
    expect(prisma.ragDocument.updateMany.mock.calls[0][0].data).not.toHaveProperty('category');
    expect(response.body.data.category).toBe('Kỹ thuật nuôi');
});

test('legacy uncategorized document can update title/description and later select a category', async () => {
    row.category = null;
    const response = await request(app).patch(`${base}/${id}`).send({ title: 'Tên mới', description: null }).expect(200);
    expect(response.body.data).toMatchObject({ title: 'Tên mới', category: null, description: null });
    const categorized = await request(app).patch(`${base}/${id}`).send({ category: 'khác' }).expect(200);
    expect(categorized.body.data.category).toBe('Khác');
});

test.each([undefined, '', null])('list category %j stays optional and returns legacy uncategorized rows', async (category) => {
    const validated = validator.list.query.validate({ category });
    expect(validated.error).toBeUndefined();
    row.category = null;
    const response = await request(app).get(base).query(category === '' ? { category } : {}).expect(200);
    expect(response.body.data[0].category).toBeNull();
    expect(prisma.ragDocument.findMany.mock.calls[0][0].where).not.toHaveProperty('category');
});

test('list keeps canonical category filtering and legacy spelling compatibility', async () => {
    await request(app).get(base).query({ category: 'khác' }).expect(200);
    expect(prisma.ragDocument.findMany.mock.calls[0][0].where.category).toEqual({ in: ['khác', 'Khác'] });
});

test('file type and 10 MiB upload boundaries remain enforced', async () => {
    await request(app).post(`${base}/upload-intents`).send({ ...upload, category: 'Khác', fileSize: RAG_DOCUMENT_MAX_FILE_BYTES }).expect(201);
    await request(app).post(`${base}/upload-intents`).send({ ...upload, category: 'Khác', fileSize: RAG_DOCUMENT_MAX_FILE_BYTES + 1 }).expect(400);
    await request(app).post(`${base}/upload-intents`).send({ ...upload, category: 'Khác', originalFilename: 'guide.exe' }).expect(400);
    // Restoring a legacy source does not require metadata or a category.
    expect(validator.createReuploadIntent.body.validate(upload).error).toBeDefined();
    const { title, ...file } = upload;
    expect(validator.createReuploadIntent.body.validate(file).error).toBeUndefined();
});
