jest.mock('../src/config', () => ({
    rateLimit: { windowMs: 900000, max: 100, writeWindowMs: 60000, writeMax: 10 },
}));
jest.mock('../src/config/logger', () => ({ error: jest.fn() }));
jest.mock('../src/middlewares/auth.middleware', () => ({
    authenticate: (req, res, next) => req.headers.authorization ? next() : res.sendStatus(401),
    authorize: () => (req, res, next) => req.headers.authorization === 'admin' ? next() : res.sendStatus(403),
}));
jest.mock('../src/controllers', () => ({
    ragDocumentController: Object.fromEntries([
        'listDocuments', 'createUploadIntent', 'completeUpload', 'createReuploadIntent',
        'completeReupload', 'cancelUpload', 'getDocument', 'downloadDocument', 'updateDocument', 'retryDocument',
    ].map((name) => [name, jest.fn((req, res) => res.sendStatus(204))])),
}));

const express = require('express');
const request = require('supertest');
const { writeLimiter } = require('../src/middlewares');
const { httpStatus, messages } = require('../src/constants');
const router = require('../src/routes/adminRagDocument.route');
const controller = require('../src/controllers').ragDocumentController;
const id = '11111111-1111-4111-8111-111111111111';
const file = { originalFilename: 'shrimp.txt', fileSize: 1, fileHash: 'a'.repeat(64) };
const receipt = { publicId: 'source', version: 1, signature: 'a'.repeat(40) };
const writes = [
    ['post', '/upload-intents', { ...file, title: 'Shrimp' }, 'createUploadIntent'],
    ['post', `/${id}/complete-upload`, receipt, 'completeUpload'],
    ['post', `/${id}/reupload-intents`, file, 'createReuploadIntent'],
    ['post', `/${id}/complete-reupload`, receipt, 'completeReupload'],
    ['post', `/${id}/cancel-upload`, {}, 'cancelUpload'],
    ['post', `/${id}/retry`, {}, 'retryDocument'],
    ['patch', `/${id}`, { title: 'Updated' }, 'updateDocument'],
];
let app;
beforeEach(() => {
    jest.clearAllMocks();
    writeLimiter.resetKey('::ffff:127.0.0.1');
    app = express();
    app.use(express.json());
    app.use(router);
});

test.each(writes)('%s %s accepts ten writes, then returns the shared 429 envelope', async (method, path, body, handler) => {
    for (let i = 0; i < 10; i++) {
        const res = await request(app)[method](path).set('Authorization', 'admin').send(body);
        expect(res.status).toBe(204);
        expect(Number(res.headers['ratelimit-remaining'])).toBe(9 - i);
    }
    const blocked = await request(app)[method](path).set('Authorization', 'admin').send(body);
    expect(blocked.status).toBe(httpStatus.TOO_MANY_REQUESTS);
    expect(blocked.body).toEqual({ success: false, statusCode: httpStatus.TOO_MANY_REQUESTS, message: messages.SERVER.TOO_MANY_REQUESTS });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-limit']).toBe('10');
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined();
    expect(controller[handler]).toHaveBeenCalledTimes(10);
});

test('all write endpoints share a quota, while reads remain available', async () => {
    for (let i = 0; i < 10; i++) {
        const [method, path, body] = writes[i % writes.length];
        await request(app)[method](path).set('Authorization', 'admin').send(body).expect(204);
    }
    await request(app).post(`/${id}/cancel-upload`).set('Authorization', 'admin').expect(429);
    for (const path of ['/', `/${id}`, `/${id}/file`]) {
        const res = await request(app).get(path).set('Authorization', 'admin');
        expect(res.status).toBe(204);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    }
});

test('authentication and Admin authorization precede the write quota', async () => {
    for (let i = 0; i < 11; i++) {
        await request(app).post(`/${id}/cancel-upload`).expect(401);
        await request(app).post(`/${id}/cancel-upload`).set('Authorization', 'technician').expect(403);
    }
    const res = await request(app).post(`/${id}/cancel-upload`).set('Authorization', 'admin');
    expect(res.status).toBe(204);
    expect(res.headers['ratelimit-remaining']).toBe('9');
});
