jest.mock('../src/config/prisma', () => ({
    account: { findUnique: jest.fn() },
    $transaction: jest.fn(),
}));
jest.mock('../src/config', () => ({
    env: 'test',
    jwt: { accessSecret: 'disease-case-test-secret' },
    rateLimit: { windowMs: 60000, max: 1000, writeWindowMs: 60000, writeMax: 1000 },
}));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const prisma = require('../src/config/prisma');
const { errorConverter, errorHandler } = require('../src/middlewares/error.middleware');

const app = express();
app.use('/owner/disease-cases', require('../src/routes/ownerDiseaseCase.route'));
app.use(errorConverter, errorHandler);

const ownerId = '10000000-0000-4000-8000-000000000001';
const seasonId = '20000000-0000-4000-8000-000000000001';
const caseId = '30000000-0000-4000-8000-000000000001';
const token = jwt.sign({ sub: ownerId, type: 'access' }, 'disease-case-test-secret');
const listPath = `?seasonId=${seasonId}`;
const detailPath = `/${caseId}`;
const ownership = { pond: { farm: { ownerId } } };
const openedAt = new Date('2026-09-05T10:20:00.000Z');
const changedAt = new Date('2026-09-05T11:00:00.000Z');
const season = { id: seasonId, name: 'Vụ Đông Xuân', shrimpType: 'WHITELEG', pond: {
    name: 'Ao A3', farm: { name: 'Trại A' },
} };
const caseCard = {
    id: caseId, title: 'Ca bệnh Ao A3', description: 'Quan sát thấy dấu hiệu bất thường',
    status: 'IN_TREATMENT', severity: 'HIGH', expert: { fullName: 'Chuyên gia A' },
    aiDiagnosisId: null, caseSnapshot: { aiDiagnosis: { label: 'White Feces Syndrome (nghi ngờ)' } },
};

const get = (path, authenticated = true) => {
    const call = request(app).get(`/owner/disease-cases${path}`);
    return authenticated ? call.set('Authorization', `Bearer ${token}`) : call;
};

let client;
beforeEach(() => {
    jest.resetAllMocks();
    client = {
        aquacultureSeason: { findFirst: jest.fn().mockResolvedValue(season) },
        diseaseCase: {
            findFirst: jest.fn(),
            findMany: jest.fn().mockResolvedValue([{ ...caseCard, _count: { responses: 4 } }]),
            groupBy: jest.fn().mockResolvedValue([
                { status: 'IN_TREATMENT', _count: { _all: 1 } },
                { status: 'RESOLVED', _count: { _all: 21 } },
            ]),
        },
        aiDiagnosisLog: { findMany: jest.fn() },
    };
    prisma.$transaction.mockImplementation((callback) => callback(client));
    prisma.account.findUnique.mockResolvedValue({ id: ownerId, role: 'FARM_OWNER', status: 'ACTIVE' });
});

test('N: list scopes the season and returns both counts and a minimal case card', async () => {
    const response = await get(listPath);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
        success: true,
        data: [{
            id: caseId, expertName: 'Chuyên gia A', responseCount: 4,
            aiDiagnosis: 'White Feces Syndrome (nghi ngờ)',
        }],
        meta: {
            page: 1, limit: 20, activeCount: 1, resolvedCount: 21,
            totalResults: 1, totalPages: 1, hasNextPage: false,
            pondName: 'Ao A3', seasonName: 'Vụ Đông Xuân',
        },
    });
    expect(response.body.data[0]).not.toHaveProperty('caseSnapshot');
    expect(response.body.data[0]).not.toHaveProperty('expert');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(client.aquacultureSeason.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: seasonId, ...ownership },
    }));
    expect(client.diseaseCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { seasonId, status: { not: 'RESOLVED' } },
        skip: 0, take: 20,
    }));
    expect(client.aiDiagnosisLog.findMany).not.toHaveBeenCalled();
});

test('B: resolved pagination uses the resolved count and preserves the season context on an empty page', async () => {
    client.diseaseCase.findMany.mockResolvedValue([]);
    const response = await get(`${listPath}&resolved=true&page=4&limit=10`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta).toMatchObject({
        activeCount: 1, resolvedCount: 21, totalPages: 3, hasNextPage: false, pondName: 'Ao A3',
    });
    expect(client.diseaseCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { seasonId, status: 'RESOLVED' }, skip: 30, take: 10,
    }));
});

test('N: detail returns historical measurements, evidence, submitted protocols and a chronological timeline', async () => {
    client.diseaseCase.findFirst.mockResolvedValue({
        ...caseCard, createdAt: openedAt, updatedAt: changedAt, resolutionSummary: null, season,
        reporter: { fullName: 'Kỹ thuật viên A' },
        caseSnapshot: {
            capturedAt: '2026-09-05T10:10:00.000Z',
            shrimpHealth: { avgWeightG: '11.90', mortalityCount: '0', healthStatus: 'warning' },
            waterQuality: { ph: 8.4, no2MgL: '1.7', nh3MgL: 0.24, temperatureC: 27 },
            observedSigns: ['Dấu hiệu tại nhá'],
        },
        attachments: [{
            fileUrl: 'https://example.com/photo.jpg', caption: 'Ảnh mẫu', mediaType: 'image/jpeg',
            createdAt: openedAt, uploader: { fullName: 'Kỹ thuật viên A' },
        }],
        protocols: [{ id: 'protocol', title: 'Phác đồ v2', versionNo: 2, status: 'PENDING_APPROVAL' }],
        responses: [{
            responseType: 'EXPERT_ASSESSMENT', message: 'Đánh giá',
            createdAt: changedAt, author: { fullName: 'Chuyên gia A', role: 'EXPERT' },
        }],
        statusHistory: [
            { fromStatus: null, toStatus: 'OPEN', changedAt: openedAt, changer: { fullName: 'Kỹ thuật viên A' } },
            { fromStatus: 'OPEN', toStatus: 'MONITORING', changedAt, changer: { fullName: 'Chuyên gia A' } },
        ],
    });
    const response = await get(detailPath);
    expect(response.status).toBe(200);
    const { data } = response.body;
    expect(data.card.responseCount).toBe(1);
    expect(data.snapshot).toEqual({
        capturedAt: '2026-09-05T10:10:00.000Z', healthStatus: 'WARNING', note: 'Dấu hiệu tại nhá',
        avgWeightG: 11.9, mortalityCount: 0, ph: 8.4, no2MgL: 1.7, nh3MgL: 0.24,
        exceededWaterMetrics: ['nh3MgL', 'no2MgL'],
    });
    expect(data.attachments[0]).toMatchObject({ caption: 'Ảnh mẫu', uploaderName: 'Kỹ thuật viên A' });
    expect(data.protocols[0]).toMatchObject({ versionNo: 2, status: 'PENDING_APPROVAL' });
    expect(data.timeline.map((event) => event.toStatus ?? event.responseType))
        .toEqual(['OPEN', 'MONITORING', 'EXPERT_ASSESSMENT']);
    const { where, select } = client.diseaseCase.findFirst.mock.calls[0][0];
    expect(where).toEqual({ id: caseId, season: ownership });
    expect(select.protocols.where).toEqual({
        protocolType: 'TREATMENT', status: { not: 'DRAFT' }, submittedAt: { not: null }, season: ownership,
    });
});

test('A: linked AI labels use the exact confidence and stay inside the requested season', async () => {
    client.diseaseCase.findMany.mockResolvedValue([{
        ...caseCard, caseSnapshot: { aiDiagnosis: { label: 'WSSV', confidence: 79 } },
        aiDiagnosisId: 'diagnosis', _count: { responses: 0 },
    }]);
    client.aiDiagnosisLog.findMany.mockResolvedValue([{
        id: 'diagnosis', predictedLabel: 'WSSV', confidence: 0.8, predictions: [{ probability: 0.799999 }],
    }]);
    const response = await get(listPath);
    expect(response.body.data[0].aiDiagnosis).toBeNull();
    expect(client.aiDiagnosisLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: { in: ['diagnosis'] }, seasonId, runStatus: 'SUCCESS' },
    }));
});

test('N: detail accepts legacy opening measurements and leaves unavailable sections empty', async () => {
    client.diseaseCase.findFirst.mockResolvedValue({
        ...caseCard, createdAt: openedAt, updatedAt: changedAt, resolutionSummary: null, season,
        reporter: { fullName: 'Kỹ thuật viên A' },
        caseSnapshot: {
            health: { avg_weight_g: '8.000', mortality_7d: 4, health_status: 'good' },
            waterIndicators: { ph: '8.1', no2_mg_l: 0.5, recorded_at: openedAt.toISOString() },
            note: 'Đốm đen nhỏ trên vỏ.',
        },
        attachments: [], protocols: [], responses: [], statusHistory: [],
    });
    const response = await get(detailPath);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
        card: { aiDiagnosis: null, responseCount: 0 },
        snapshot: {
            avgWeightG: 8, mortalityCount: 4, healthStatus: 'GOOD', ph: 8.1, no2MgL: 0.5,
            nh3MgL: null, exceededWaterMetrics: [], capturedAt: openedAt.toISOString(),
        },
        attachments: [], protocols: [], timeline: [],
    });
});

test('A: foreign or missing season and case use 404 without leaking records', async () => {
    client.aquacultureSeason.findFirst.mockResolvedValue(null);
    client.diseaseCase.findFirst.mockResolvedValue(null);
    expect((await get(listPath)).status).toBe(404);
    expect((await get(detailPath)).status).toBe(404);
    expect(client.diseaseCase.findMany).not.toHaveBeenCalled();
    expect(client.aiDiagnosisLog.findMany).not.toHaveBeenCalled();
});

test('A: anonymous and non-owner accounts cannot access the read endpoints', async () => {
    expect((await get(listPath, false)).status).toBe(401);
    prisma.account.findUnique.mockResolvedValue({ id: ownerId, role: 'TECHNICIAN', status: 'ACTIVE' });
    expect((await get(detailPath)).status).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
});

test.each([
    '', '?seasonId=bad', `${listPath}&ownerId=other`, `${listPath}&resolved=all`,
    `${listPath}&page=0`, `${listPath}&limit=101`, '/invalid-id', `${detailPath}?include=all`,
])('A/B: rejects invalid input %s before querying cases', async (path) => {
    expect((await get(path)).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
});
