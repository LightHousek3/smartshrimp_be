jest.mock('../src/config/prisma', () => ({
    seasonPersonnelAssignment: { findMany: jest.fn(), count: jest.fn() },
}));
jest.mock('../src/services', () => ({ assignedSeasonService: require('../src/services/assignedSeason.service') }));
jest.mock('../src/controllers', () => ({ assignedSeasonController: require('../src/controllers/assignedSeason.controller') }));
jest.mock('../src/validators', () => ({ assignedSeasonValidator: require('../src/validators/assignedSeason.validator') }));
jest.mock('../src/middlewares', () => ({
    validate: require('../src/middlewares/validate.middleware'),
    authenticate: (req, res, next) => {
        if (!req.headers.authorization) return res.status(401).json({ success: false, statusCode: 401 });
        req.account = { id: 'account' };
        return next();
    },
    authorize: (role) => (req, res, next) => req.headers.authorization === role
        ? next() : res.status(403).json({ success: false, statusCode: 403 }),
}));
const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/prisma');
const app = express();
app.use('/api/v1/me/seasons', require('../src/routes/assignedSeason.route'));
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({
    success: false, statusCode: error.statusCode || 500, message: error.message,
}));
beforeEach(() => {
    jest.resetAllMocks();
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
    prisma.seasonPersonnelAssignment.count.mockResolvedValue(0);
});
test('the reported GET limit=20&status=active returns the paginated envelope without removed columns', async () => {
    const response = await request(app).get('/api/v1/me/seasons?limit=20&status=active').set('Authorization', 'TECHNICIAN').expect(200);
    expect(response.body).toMatchObject({ success: true, data: [], meta: {
        limit: 20, totalResults: 0, activeResults: 0, allResults: 0, hasNextPage: false, nextCursor: null,
    } });
    const query = prisma.seasonPersonnelAssignment.findMany.mock.calls[0][0];
    expect(query.where.AND[0]).toMatchObject({ accountId: 'account', role: 'TECHNICIAN', unassignedAt: null, season: { status: 'ACTIVE' } });
    expect(JSON.stringify(query)).not.toMatch(/isDeleted|deletedAt/);
});
test('authentication, role, invalid input and unexpected errors keep their status', async () => {
    const path = '/api/v1/me/seasons';
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', 'FARM_OWNER').expect(403);
    await request(app).get(`${path}?limit=1`).set('Authorization', 'TECHNICIAN').expect(400);
    await request(app).get(`${path}?status=invalid`).set('Authorization', 'TECHNICIAN').expect(400);
    prisma.seasonPersonnelAssignment.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    await request(app).get(path).set('Authorization', 'TECHNICIAN').expect(500);
});
