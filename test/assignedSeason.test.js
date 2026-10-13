jest.mock('../src/config/prisma', () => ({
    seasonPersonnelAssignment: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
}));
const Joi = require('joi');
const prisma = require('../src/config/prisma');
const service = require('../src/services/assignedSeason.service');
const validator = require('../src/validators/assignedSeason.validator');
const accountId = '22222222-2222-4222-8222-222222222222';
const seasonId = '11111111-1111-4111-8111-111111111111';
const date = new Date('2026-10-01T00:00:00Z');
const assignment = (index = 1) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    assignedAt: date,
    season: {
        id: seasonId, name: 'Season', status: 'ACTIVE', shrimpType: 'WHITELEG',
        stockingDate: date, expectedEndDate: null,
        pond: { id: 'pond', name: 'Pond', status: 'INACTIVE', farm: { id: 'farm', name: 'Farm' } },
    },
});
beforeEach(() => {
    jest.resetAllMocks();
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([assignment()]);
    prisma.seasonPersonnelAssignment.count.mockResolvedValue(1);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue(assignment());
});

test('lowercase active query validates and list scopes every count to the current technician', async () => {
    const result = Joi.compile(validator.getAssignedSeasons).validate({ query: { status: 'active', limit: 20 } });
    expect(result.error).toBeUndefined();
    expect(result.value.query.status).toBe('ACTIVE');
    const response = await service.getAssignedSeasons(accountId, result.value.query);
    expect(response.seasons[0]).toMatchObject({ id: seasonId, pond: { status: 'INACTIVE' }, farm: { id: 'farm' } });
    expect(response.meta).toEqual({ limit: 20, totalResults: 1, activeResults: 1, allResults: 1, hasNextPage: false, nextCursor: null });
    const queries = [prisma.seasonPersonnelAssignment.findMany.mock.calls[0][0],
        ...prisma.seasonPersonnelAssignment.count.mock.calls.map(([query]) => query)];
    for (const query of queries) {
        expect(JSON.stringify(query)).not.toMatch(/isDeleted|deletedAt/);
    }
    expect(queries[0].where.AND[0]).toMatchObject({ accountId, role: 'TECHNICIAN', unassignedAt: null, season: { status: 'ACTIVE' } });
    expect(queries[1].where).toMatchObject({ accountId, role: 'TECHNICIAN', unassignedAt: null, season: { status: 'ACTIVE' } });
    expect(queries[2].where.season.status).toBe('ACTIVE');
    expect(queries[3].where.season).not.toHaveProperty('status');
});
test('farm/search filters stay on the same scope and status-independent counts', async () => {
    await service.getAssignedSeasons(accountId, { status: 'COMPLETED', farmId: 'farm', search: 'pond' });
    for (const [query] of prisma.seasonPersonnelAssignment.count.mock.calls) {
        expect(query.where.season.pond.farm.id).toBe('farm');
        expect(query.where.season.OR).toEqual([
            { name: { contains: 'pond', mode: 'insensitive' } },
            { pond: { name: { contains: 'pond', mode: 'insensitive' } } },
        ]);
    }
});
test('pagination uses assignment tie-break and validates cursor inside account scope', async () => {
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue(Array.from({ length: 21 }, (_, i) => assignment(21 - i)));
    const first = await service.getAssignedSeasons(accountId);
    expect(first.seasons).toHaveLength(20);
    expect(first.meta.hasNextPage).toBe(true);
    await service.getAssignedSeasons(accountId, { cursor: first.meta.nextCursor });
    expect(prisma.seasonPersonnelAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ accountId, role: 'TECHNICIAN', unassignedAt: null, id: assignment(2).id }),
    }));
    expect(prisma.seasonPersonnelAssignment.findMany.mock.calls[1][0].where.AND[1].OR).toHaveLength(2);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(null);
    await expect(service.getAssignedSeasons(accountId, { cursor: first.meta.nextCursor })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.getAssignedSeasons(accountId, { cursor: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
});
test('detail retains current-assignment and same-farm scope without deleted fields', async () => {
    const row = assignment();
    row.season.personnelAssignments = [];
    row.season.healthLogs = [{ estimatedBiomassKg: '123.4' }];
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue(row);
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
    const detail = await service.getAssignedSeason(accountId, seasonId);
    expect(detail.currentBiomassKg).toBe(123.4);
    expect(prisma.seasonPersonnelAssignment.findFirst.mock.calls[0][0].where).toEqual({ accountId, seasonId, role: 'TECHNICIAN', unassignedAt: null });
    expect(prisma.seasonPersonnelAssignment.findMany.mock.calls[0][0].where).toMatchObject({ accountId, role: 'TECHNICIAN', unassignedAt: null, seasonId: { not: seasonId }, season: { pond: { farmId: 'farm' } } });
    expect(JSON.stringify(prisma.seasonPersonnelAssignment.findMany.mock.calls)).not.toMatch(/isDeleted|deletedAt/);
});
test('empty/missing assignment and database failures keep their error semantics', async () => {
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValueOnce([]);
    expect((await service.getAssignedSeasons(accountId)).seasons).toEqual([]);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(null);
    await expect(service.getAssignedSeason(accountId, seasonId)).rejects.toMatchObject({ statusCode: 404 });
    prisma.seasonPersonnelAssignment.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.getAssignedSeasons(accountId)).rejects.toThrow('database unavailable');
});
