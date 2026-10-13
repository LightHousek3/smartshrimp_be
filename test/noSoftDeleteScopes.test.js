jest.mock('../src/config/prisma', () => {
    const delegate = () => ({ findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn() });
    return {
        account: delegate(), farm: delegate(), pond: delegate(), aquacultureSeason: delegate(),
        seasonPersonnelAssignment: delegate(), technicianKpi: delegate(),
        diseaseCase: delegate(), protocol: delegate(), ragConversation: delegate(),
        $queryRawUnsafe: jest.fn(), $transaction: jest.fn(),
    };
});
jest.mock('../src/services/ragClient.service', () => ({ ask: jest.fn() }));
jest.mock('../src/realtime/notification.socket', () => ({ emitNotification: jest.fn() }));
const prisma = require('../src/config/prisma');
const seasonService = require('../src/services/season.service');
const expertSeason = require('../src/services/expertSeason.service');
const dashboard = require('../src/services/expertDashboard.service');
const personnel = require('../src/services/personnel.service');
const rag = require('../src/services/rag.service');
let season;
const noRemovedColumns = (...queries) => expect(JSON.stringify(queries)).not.toMatch(/isDeleted|deletedAt/);
beforeEach(() => {
    jest.resetAllMocks();
    for (const delegate of Object.values(prisma).filter((value) => value.findMany)) {
        delegate.findMany.mockResolvedValue([]);
        delegate.count.mockResolvedValue(0);
    }
    season = {
        id: 'season', status: 'PLANNING', stockingDate: new Date('2026-01-01'),
        initialQuantity: 1000n, initialDensityPerM2: 10,
        pond: { id: 'pond', status: 'AVAILABLE', type: 'AQUACULTURE', areaM2: 100, farm: { id: 'farm', status: 'ACTIVE' } },
        personnelAssignments: ['TECHNICIAN', 'EXPERT'].map((role) => ({ role, unassignedAt: null, account: { status: 'ACTIVE' } })),
    };
    prisma.aquacultureSeason.findFirst.mockImplementation(async () => season);
    prisma.$queryRawUnsafe.mockImplementation(async (sql) => sql.includes('to_regclass') ? [{ exists: true }] : [{ id: 'protocol', status: 'APPROVED' }]);
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
});
test('season activation eligibility follows actual farm status and keeps owner scope', async () => {
    expect((await seasonService.getSeason('season', 'owner')).activationEligibility.canActivate).toBe(true);
    season.pond.farm.status = 'INACTIVE';
    const response = await seasonService.getSeason('season', 'owner');
    expect(response.activationEligibility).toEqual({ canActivate: false, missingConditions: ['FARM_NOT_ACTIVE'] });
    const query = prisma.aquacultureSeason.findFirst.mock.calls[0][0];
    expect(query.where).toEqual({ id: 'season', pond: { farm: { ownerId: 'owner' } } });
    expect(query.select.pond.select.farm.select.status).toBe(true);
    noRemovedColumns(query);
});
test('creating a season in an inactive farm fails before any create', async () => {
    season.pond.farm.status = 'INACTIVE';
    prisma.pond.findFirst.mockResolvedValue(season.pond);
    await expect(seasonService.createSeason({ pondId: 'pond' }, 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(prisma.aquacultureSeason.count).not.toHaveBeenCalled();
    noRemovedColumns(prisma.pond.findFirst.mock.calls);
});
test('expert season list and dashboard preserve expert assignment/status restrictions', async () => {
    await expertSeason.getAssignedSeasons('expert', { status: 'ACTIVE', farmId: 'farm' });
    const query = prisma.aquacultureSeason.findMany.mock.calls[0][0];
    expect(JSON.stringify(query.where)).toContain('expert');
    expect(JSON.stringify(query.where)).toContain('EXPERT');
    expect(query.where.AND).toContainEqual({ status: 'ACTIVE' });
    expect(query.where.AND).toContainEqual({ pond: { farmId: 'farm' } });
    await dashboard.getExpertDashboard('expert');
    const assignment = prisma.seasonPersonnelAssignment.findMany.mock.calls[0][0];
    expect(assignment.where).toEqual({ accountId: 'expert', role: 'EXPERT', unassignedAt: null, season: { status: 'ACTIVE' } });
    noRemovedColumns(query, assignment, prisma.farm.findMany.mock.calls);
});
test('personnel details keep managed-by and same-owner history filters', async () => {
    prisma.account.findFirst.mockResolvedValue({ id: 'technician', role: 'TECHNICIAN' });
    prisma.technicianKpi.findUnique.mockResolvedValue(null);
    await personnel.getPersonnelById('owner', 'technician');
    expect(prisma.account.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'technician', managedByOwnerId: 'owner' });
    const query = prisma.seasonPersonnelAssignment.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ accountId: 'technician', role: 'TECHNICIAN', season: { pond: { farm: { ownerId: 'owner' } } } });
    noRemovedColumns(query);
});
test('RAG conversations still require an active technician and a current season assignment', async () => {
    prisma.account.findUnique.mockResolvedValue({ role: 'TECHNICIAN', status: 'ACTIVE' });
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({ season: { id: 'season', status: 'ACTIVE' } });
    await rag.listConversations('technician', { seasonId: 'season' });
    const query = prisma.seasonPersonnelAssignment.findFirst.mock.calls[0][0];
    expect(query.where).toEqual({ accountId: 'technician', seasonId: 'season', role: 'TECHNICIAN', unassignedAt: null });
    noRemovedColumns(query);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(null);
    await expect(rag.listConversations('technician', { seasonId: 'other-season' })).rejects.toMatchObject({ statusCode: 403 });
    prisma.account.findUnique.mockResolvedValueOnce({ role: 'FARM_OWNER', status: 'ACTIVE' });
    await expect(rag.listConversations('owner', { seasonId: 'season' })).rejects.toMatchObject({ statusCode: 403 });
});
