jest.mock('../../src/config/prisma', () => ({
    account: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
    },
    seasonPersonnelAssignment: { findMany: jest.fn() },
    aquacultureSeason: { findMany: jest.fn() },
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

test('returns owned personnel detail with current assignment count', async () => {
    prisma.account.findFirst.mockResolvedValue(staff);
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
        { accountId: staffId, seasonId: 'season-1' },
        { accountId: staffId, seasonId: 'season-2' },
    ]);
    prisma.aquacultureSeason.findMany.mockResolvedValue([{ id: 'season-1' }]);

    const result = await personnelService.getPersonnelById(ownerId, staffId);
    expect(result).toEqual({ ...staff, currentSeasonAssignments: 1 });
});
