jest.mock('../src/config/prisma', () => ({
    aquacultureSeason: { findUnique: jest.fn() },
    seasonPersonnelAssignment: { findFirst: jest.fn() },
    waterQualityLog: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
}));
jest.mock('../src/realtime/notification.socket', () => ({ emitNotification: jest.fn() }));
jest.mock('../src/services', () => ({ waterLogService: require('../src/services/waterLog.service') }));
jest.mock('../src/controllers', () => ({
    waterLogController: require('../src/controllers/waterLog.controller'),
    expertSeasonController: { getAssignedSeasons: jest.fn() },
    seasonController: Object.fromEntries(['getSeasons', 'createSeason', 'assignPersonnel', 'replacePersonnel', 'getSeason', 'activateSeason', 'cancelSeason', 'updateSeason'].map((name) => [name, jest.fn()])),
}));
jest.mock('../src/validators', () => ({
    waterLogValidator: require('../src/validators/waterLog.validator'),
    expertSeasonValidator: { getAssignedSeasons: {} },
    seasonValidator: Object.fromEntries(['getSeasons', 'createSeason', 'assignPersonnel', 'replacePersonnel', 'getSeason', 'activateSeason', 'cancelSeason', 'updateSeason'].map((name) => [name, {}])),
}));
jest.mock('../src/middlewares', () => ({
    validate: require('../src/middlewares/validate.middleware'),
    authenticate: (req, res, next) => {
        if (!req.headers.authorization) return res.status(401).json({ success: false, statusCode: 401, message: 'Unauthorized' });
        req.account = { id: req.headers.authorization === 'FARM_OWNER' ? 'owner' : 'account' };
        next();
    },
    authorize: (role) => (req, res, next) => req.headers.authorization === role
        ? next() : res.status(403).json({ success: false, statusCode: 403, message: 'Forbidden' }),
}));
const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/prisma');
const app = express();
app.use('/me/seasons/:seasonId/water-logs', require('../src/routes/waterLog.route'));
app.use('/expert/seasons', require('../src/routes/expertSeason.route'));
app.use('/owner/seasons', require('../src/routes/season.route'));
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({
    success: false, statusCode: error.statusCode || 500, message: error.message,
}));
const seasonId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    jest.clearAllMocks();
    prisma.aquacultureSeason.findUnique.mockResolvedValue({ shrimpType: 'BLACK_TIGER', status: 'COMPLETED',
        pond: { isDeleted: false, farm: { isDeleted: false, ownerId: 'owner' } } });
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    prisma.waterQualityLog.findMany.mockResolvedValue([]);
    prisma.waterQualityLog.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
});
test.each([['me', 'TECHNICIAN'], ['expert', 'EXPERT'], ['owner', 'FARM_OWNER']])('%s list preserves envelope/auth and accepts additive filter/counts', async (prefix, role) => {
    const path = `/${prefix}/seasons/${seasonId}/water-logs`;
    const response = await request(app).get(path).query({ filter: 'warning', includeCounts: true }).set('Authorization', role).expect(200);
    expect(response.body).toMatchObject({ success: true, data: [], meta: {
        totalResults: 0, hasNextPage: false, nextCursor: null,
        counts: { all: 0, valid: 0, warning: 0, voided: 0 },
    } });
    const legacy = await request(app).get(path).set('Authorization', role).expect(200);
    expect(legacy.body.meta).not.toHaveProperty('counts');
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', 'ADMIN').expect(403);
    for (const query of [{ filter: 'bad' }, { includeCounts: 'bad' }, { cursor: 'bad' }, { limit: 51 }]) {
        const result = await request(app).get(path).query(query).set('Authorization', role).expect(400);
        expect(result.body).toMatchObject({ success: false, statusCode: 400, message: expect.any(String) });
    }
});
test.each([['me', 'TECHNICIAN'], ['expert', 'EXPERT'], ['owner', 'FARM_OWNER']])('%s metadata route returns the BE envelope and protects access', async (prefix, role) => {
    const path = `/${prefix}/seasons/${seasonId}/water-logs/metadata`;
    const result = await request(app).get(path).set('Authorization', role).expect(200);
    expect(result.body).toMatchObject({ success: true, message: expect.any(String), data: { schemaVersion: 1, shrimpType: 'BLACK_TIGER' } });
    expect(result.body.data.metrics).toHaveLength(8);
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', 'ADMIN').expect(403);
    await request(app).get(`/${prefix}/seasons/invalid/water-logs/metadata`).set('Authorization', role).expect(400);
});
test('metadata route propagates missing season, scope and database failures', async () => {
    const path = `/me/seasons/${seasonId}/water-logs/metadata`;
    prisma.aquacultureSeason.findUnique.mockResolvedValueOnce(null);
    await request(app).get(path).set('Authorization', 'TECHNICIAN').expect(404);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(null);
    await request(app).get(path).set('Authorization', 'TECHNICIAN').expect(403);
    prisma.aquacultureSeason.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await request(app).get(path).set('Authorization', 'TECHNICIAN').expect(500);
});
