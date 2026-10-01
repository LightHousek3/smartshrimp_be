jest.mock('../../src/config/prisma', () => ({
    account: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
    },
    seasonPersonnelAssignment: { findMany: jest.fn() },
    aquacultureSeason: { findMany: jest.fn() },
    technicianKpi: { findUnique: jest.fn() },
    expertKpi: { findUnique: jest.fn() },
}));

const prisma = require('../../src/config/prisma');
const personnelService = require('../../src/services/personnel.service');

const ownerId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const otherStaffId = '33333333-3333-4333-8333-333333333333';
const staff = {
    id: staffId,
    email: 'staff@example.com',
    role: 'TECHNICIAN',
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
    prisma.aquacultureSeason.findMany.mockResolvedValue([]);
    prisma.technicianKpi.findUnique.mockResolvedValue(null);
    prisma.expertKpi.findUnique.mockResolvedValue(null);
});

test('lists only staff managed by the owner with pagination and open assignment counts', async () => {
    prisma.account.findMany.mockResolvedValue([staff, { ...staff, id: otherStaffId }]);
    prisma.account.count.mockResolvedValue(2);
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
        { accountId: staffId, seasonId: 'season-1' },
        { accountId: staffId, seasonId: 'season-1' },
        { accountId: staffId, seasonId: 'season-2' },
    ]);
    prisma.aquacultureSeason.findMany.mockResolvedValue([{ id: 'season-1' }]);

    const result = await personnelService.getListPersonnel(ownerId, {
        limit: 1,
        role: 'TECHNICIAN',
        status: 'ACTIVE',
        search: 'staff',
    });

    expect(prisma.account.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
            managedByOwnerId: ownerId,
            role: 'TECHNICIAN',
            status: 'ACTIVE',
            OR: expect.any(Array),
        }),
        take: 2,
    }));
    expect(result.personnel).toEqual([{ ...staff, currentSeasonAssignments: 1 }]);
    expect(result.meta).toEqual({
        limit: 1,
        totalResults: 2,
        hasNextPage: true,
        nextCursor: staffId,
    });
});

test('rejects a cursor outside the owner and current filters', async () => {
    prisma.account.findFirst.mockResolvedValue(null);

    await expect(personnelService.getListPersonnel(ownerId, { cursor: otherStaffId }))
        .rejects.toMatchObject({ statusCode: 400 });
    expect(prisma.account.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ managedByOwnerId: ownerId, id: otherStaffId }),
    }));
    expect(prisma.account.findMany).not.toHaveBeenCalled();
});

test('does not reveal another owner\'s personnel detail', async () => {
    prisma.account.findFirst.mockResolvedValue(null);

    await expect(personnelService.getPersonnelById(ownerId, otherStaffId))
        .rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.account.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: {
            id: otherStaffId,
            managedByOwnerId: ownerId,
            role: { in: ['TECHNICIAN', 'EXPERT'] },
        },
    }));
});

test('returns technician detail with KPI, current assignments, and history', async () => {
    prisma.account.findFirst.mockResolvedValue(staff);
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
        {
            id: 'assignment-current',
            role: 'TECHNICIAN',
            assignedAt: new Date('2026-02-01T00:00:00Z'),
            unassignedAt: null,
            replacementReason: null,
            season: {
                id: 'season-1',
                name: 'Vụ Đông Xuân 2026',
                status: 'ACTIVE',
                pond: {
                    id: 'pond-1',
                    name: 'Ao A5',
                    farm: { id: 'farm-1', name: 'Trang trại Của Lập' },
                },
            },
        },
        {
            id: 'assignment-history',
            role: 'TECHNICIAN',
            assignedAt: new Date('2025-06-25T00:00:00Z'),
            unassignedAt: new Date('2025-09-30T00:00:00Z'),
            replacementReason: 'Điều chuyển nhân sự',
            season: {
                id: 'season-2',
                name: 'Vụ Hè Thu 2025',
                status: 'COMPLETED',
                pond: {
                    id: 'pond-2',
                    name: 'Ao A3',
                    farm: { id: 'farm-1', name: 'Trang trại Của Lập' },
                },
            },
        },
    ]);
    prisma.technicianKpi.findUnique.mockResolvedValue({
        technicianId: staffId,
        seasonsParticipated: 3n,
        completedTasks: 12n,
        onTimeCompletedTasks: 10n,
        onTimeCompletionRatePct: 83.33,
    });

    const result = await personnelService.getPersonnelById(ownerId, staffId);
    expect(prisma.seasonPersonnelAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
            where: {
                accountId: staffId,
                role: 'TECHNICIAN',
                season: {
                    pond: {
                        AND: [
                            { isDeleted: false },
                            { farm: { AND: [{ isDeleted: false }, { ownerId }] } },
                        ],
                    },
                },
            },
        }),
    );
    expect(result).toMatchObject({
        ...staff,
        currentSeasonAssignments: 1,
        kpi: {
            seasonsParticipated: 3,
            completedTasks: 12,
            onTimeCompletedTasks: 10,
            onTimeCompletionRatePct: 83.33,
        },
        currentAssignments: [
            expect.objectContaining({
                id: 'assignment-current',
                seasonId: 'season-1',
                seasonName: 'Vụ Đông Xuân 2026',
                pondId: 'pond-1',
                pondName: 'Ao A5',
                farmId: 'farm-1',
                farmName: 'Trang trại Của Lập',
            }),
        ],
        assignmentHistory: [
            expect.objectContaining({
                id: 'assignment-history',
                seasonId: 'season-2',
                pondName: 'Ao A3',
                replacementReason: 'Điều chuyển nhân sự',
            }),
        ],
    });
});

test('returns zeroed expert KPI when no projection exists', async () => {
    prisma.account.findFirst.mockResolvedValue({ ...staff, role: 'EXPERT' });

    const result = await personnelService.getPersonnelById(ownerId, staffId);

    expect(prisma.expertKpi.findUnique).toHaveBeenCalledWith({
        where: { expertId: staffId },
    });
    expect(result.kpi).toEqual({
        seasonsParticipated: 0,
        diseaseCasesHandled: 0,
        diseaseCasesResolved: 0,
        avgResolutionHours: null,
    });
    expect(result.currentAssignments).toEqual([]);
    expect(result.assignmentHistory).toEqual([]);
});

test.each(['TECHNICIAN', 'EXPERT'])(
    'filters deleted ponds and farms from %s assignment queries',
    async (role) => {
        prisma.account.findFirst.mockResolvedValue({ ...staff, role });

        const result = await personnelService.getPersonnelById(ownerId, staffId);

        expect(prisma.seasonPersonnelAssignment.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    accountId: staffId,
                    role,
                    season: {
                        pond: {
                            AND: [
                                { isDeleted: false },
                                { farm: { AND: [{ isDeleted: false }, { ownerId }] } },
                            ],
                        },
                    },
                },
            }),
        );
        expect(result.currentAssignments).toEqual([]);
        expect(result.assignmentHistory).toEqual([]);
    },
);
