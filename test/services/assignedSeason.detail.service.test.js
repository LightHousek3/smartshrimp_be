jest.mock('../../src/config/prisma', () => ({
    seasonPersonnelAssignment: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
    },
}));

const prisma = require('../../src/config/prisma');
const assignedSeasonService = require('../../src/services/assignedSeason.service');

beforeEach(() => {
    jest.clearAllMocks();
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({
        assignedAt: new Date('2026-09-29T00:00:00.000Z'),
        season: {
            id: 'season-1',
            name: 'Vụ 1',
            status: 'ACTIVE',
            shrimpType: 'WHITELEG',
            stockingDate: new Date('2026-09-29T00:00:00.000Z'),
            expectedEndDate: new Date('2027-01-15T00:00:00.000Z'),
            initialQuantity: BigInt(500000),
            initialDensityPerM2: 100,
            pond: {
                id: 'pond-1',
                name: 'Ao A1',
                type: 'AQUACULTURE',
                status: 'AVAILABLE',
                areaM2: 5000,
                depthM: 1.5,
                volumeM3: 7500,
                farm: { id: 'farm-1', name: 'Trại 1', address: null },
            },
            personnelAssignments: [],
            healthLogs: [{ estimatedBiomassKg: 1234.5 }],
        },
    });
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
});

test('returns the latest non-voided health biomass with stocking metrics', async () => {
    const result = await assignedSeasonService.getAssignedSeason('account-1', 'season-1');

    expect(result).toMatchObject({
        initialQuantity: 500000,
        initialDensityPerM2: 100,
        currentBiomassKg: 1234.5,
        expectedEndDate: '2027-01-15',
    });
    expect(prisma.seasonPersonnelAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
            select: expect.objectContaining({
                season: expect.objectContaining({
                    select: expect.objectContaining({
                        healthLogs: expect.objectContaining({
                            where: { isVoided: false },
                            take: 1,
                        }),
                    }),
                }),
            }),
        }),
    );
});

test('returns null biomass when no health log is available', async () => {
    const assignment = await prisma.seasonPersonnelAssignment.findFirst();
    assignment.season.healthLogs = [];
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(assignment);

    const result = await assignedSeasonService.getAssignedSeason('account-1', 'season-1');

    expect(result.currentBiomassKg).toBeNull();
});
