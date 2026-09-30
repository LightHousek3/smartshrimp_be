jest.mock('../../src/config/prisma', () => ({
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    aquacultureSeason: { findFirst: jest.fn() },
    account: { findFirst: jest.fn() },
    seasonPersonnelAssignment: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    task: { updateMany: jest.fn() },
    notification: {
        create: jest.fn(),
        createMany: jest.fn(),
    },
}));
jest.mock('../../src/realtime/notification.socket', () => ({
    emitNotification: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const { emitNotification } = require('../../src/realtime/notification.socket');
const seasonService = require('../../src/services/season.service');

const ownerId = '11111111-1111-4111-8111-111111111111';
const seasonId = '22222222-2222-4222-8222-222222222222';
const previousAccountId = '33333333-3333-4333-8333-333333333333';
const replacementAccountId = '44444444-4444-4444-8444-444444444444';
const currentAssignmentId = '55555555-5555-4555-8555-555555555555';
const newAssignmentId = '66666666-6666-4666-8666-666666666666';
const notificationId = '77777777-7777-4777-8777-777777777777';
const season = { id: seasonId, name: 'Vụ Đông Xuân', status: 'PLANNING' };

const buildAssignment = (role = 'TECHNICIAN') => ({
    id: newAssignmentId,
    seasonId,
    role,
    assignedAt: new Date('2026-09-29T10:00:00.000Z'),
    account: {
        id: replacementAccountId,
        email: 'replacement@example.com',
        fullName: 'Nhân sự thay thế',
        phone: null,
        status: 'ACTIVE',
    },
});

beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.aquacultureSeason.findFirst.mockResolvedValue(season);
    prisma.account.findFirst.mockResolvedValue({ id: replacementAccountId });
    prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
    prisma.seasonPersonnelAssignment.create.mockResolvedValue(buildAssignment());
    prisma.seasonPersonnelAssignment.updateMany.mockResolvedValue({ count: 1 });
    prisma.task.updateMany.mockResolvedValue({ count: 0 });
    prisma.$executeRawUnsafe.mockResolvedValue(0);
    prisma.notification.create.mockResolvedValue({ id: notificationId });
    prisma.notification.createMany.mockResolvedValue({ count: 2 });
});

describe('assignPersonnel', () => {
    const input = { accountId: replacementAccountId, role: 'TECHNICIAN' };

    test('assigns eligible personnel and creates their notification atomically', async () => {
        const assignment = buildAssignment();
        prisma.seasonPersonnelAssignment.create.mockResolvedValue(assignment);

        const result = await seasonService.assignPersonnel(seasonId, input, ownerId);

        expect(prisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
        expect(prisma.account.findFirst).toHaveBeenCalledWith({
            where: {
                id: replacementAccountId,
                managedByOwnerId: ownerId,
                role: 'TECHNICIAN',
                status: 'ACTIVE',
            },
            select: { id: true },
        });
        expect(prisma.seasonPersonnelAssignment.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    seasonId,
                    role: 'TECHNICIAN',
                    accountId: replacementAccountId,
                    assignedBy: ownerId,
                },
            }),
        );
        expect(prisma.notification.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                accountId: replacementAccountId,
                type: 'SEASON_ASSIGNMENT_CREATED',
                referenceId: seasonId,
            }),
            select: { id: true },
        });
        expect(emitNotification).toHaveBeenCalledWith(
            replacementAccountId,
            'notification:new',
            { id: notificationId, referenceId: seasonId },
        );
        expect(result).toBe(assignment);
    });

    test('allows assignment while the season is active', async () => {
        prisma.aquacultureSeason.findFirst.mockResolvedValue({ ...season, status: 'ACTIVE' });

        await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
            .resolves.toEqual(buildAssignment());
    });

    test('does not reveal a season outside the owner scope', async () => {
        prisma.aquacultureSeason.findFirst.mockResolvedValue(null);

        await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
            .rejects.toMatchObject({ statusCode: 404 });
        expect(prisma.account.findFirst).not.toHaveBeenCalled();
    });

    test.each(['COMPLETED', 'CANCELLED'])(
        'rejects assignment when the season is %s',
        async (status) => {
            prisma.aquacultureSeason.findFirst.mockResolvedValue({ ...season, status });

            await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
                .rejects.toMatchObject({ statusCode: 409 });
            expect(prisma.seasonPersonnelAssignment.create).not.toHaveBeenCalled();
        },
    );

    test('rejects personnel outside the active managed role scope', async () => {
        prisma.account.findFirst.mockResolvedValue(null);

        await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
            .rejects.toMatchObject({ statusCode: 404 });
        expect(prisma.seasonPersonnelAssignment.create).not.toHaveBeenCalled();
    });

    test('requires replacement when the requested role is already occupied', async () => {
        prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
            { role: 'TECHNICIAN', accountId: previousAccountId },
        ]);

        await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
            .rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.seasonPersonnelAssignment.create).not.toHaveBeenCalled();
    });

    test('rejects a person already assigned to another role in the season', async () => {
        prisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
            { role: 'EXPERT', accountId: replacementAccountId },
        ]);

        await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
            .rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.seasonPersonnelAssignment.create).not.toHaveBeenCalled();
    });

    test.each(['P2002', 'P2003', 'P2034'])(
        'maps Prisma %s to a conflict without emitting realtime notification',
        async (code) => {
            prisma.$transaction.mockRejectedValue({ code });

            await expect(seasonService.assignPersonnel(seasonId, input, ownerId))
                .rejects.toMatchObject({ statusCode: 409 });
            expect(emitNotification).not.toHaveBeenCalled();
        },
    );
});

describe('replacePersonnel', () => {
    const input = {
        accountId: replacementAccountId,
        expectedAssignmentId: currentAssignmentId,
        reason: 'Điều chuyển công việc',
    };

    const arrangeCurrentAssignment = () => {
        prisma.seasonPersonnelAssignment.findFirst
            .mockResolvedValueOnce({ id: currentAssignmentId, accountId: previousAccountId })
            .mockResolvedValueOnce(null);
    };

    test('replaces a technician and transfers their open tasks', async () => {
        arrangeCurrentAssignment();
        prisma.task.updateMany.mockResolvedValue({ count: 3 });
        const assignment = buildAssignment('TECHNICIAN');
        prisma.seasonPersonnelAssignment.create.mockResolvedValue(assignment);

        const result = await seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        );

        expect(prisma.seasonPersonnelAssignment.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: currentAssignmentId,
                    unassignedAt: null,
                    replacedByAssignmentId: null,
                }),
                data: expect.objectContaining({
                    unassignedBy: ownerId,
                    replacementReason: input.reason,
                }),
            }),
        );
        expect(prisma.seasonPersonnelAssignment.updateMany).toHaveBeenNthCalledWith(2, {
            where: {
                id: currentAssignmentId,
                replacedByAssignmentId: null,
            },
            data: { replacedByAssignmentId: newAssignmentId },
        });
        expect(prisma.task.updateMany).toHaveBeenCalledWith({
            where: {
                seasonId,
                assignedTo: previousAccountId,
                status: { in: ['PENDING', 'IN_PROGRESS'] },
            },
            data: {
                assignedTo: replacementAccountId,
                updatedAt: expect.any(Date),
            },
        });
        expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            assignment,
            transferredTaskCount: 3,
            transferredDiseaseCaseCount: 0,
            replacedAssignment: {
                id: currentAssignmentId,
                accountId: previousAccountId,
                unassignedBy: ownerId,
                replacementReason: input.reason,
                replacedByAssignmentId: newAssignmentId,
            },
        });
        expect(prisma.notification.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
                expect.objectContaining({
                    accountId: previousAccountId,
                    type: 'SEASON_ASSIGNMENT_REPLACED',
                }),
                expect.objectContaining({
                    accountId: replacementAccountId,
                    type: 'SEASON_ASSIGNMENT_REPLACED',
                }),
            ]),
        });
        expect(emitNotification).toHaveBeenCalledTimes(2);
    });

    test('replaces an expert and transfers unresolved disease cases', async () => {
        arrangeCurrentAssignment();
        prisma.seasonPersonnelAssignment.create.mockResolvedValue(buildAssignment('EXPERT'));
        prisma.$executeRawUnsafe.mockResolvedValue(2);

        const result = await seasonService.replacePersonnel(
            seasonId,
            'EXPERT',
            input,
            ownerId,
        );

        expect(prisma.task.updateMany).not.toHaveBeenCalled();
        expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining("status <> 'resolved'"),
            replacementAccountId,
            expect.any(Date),
            seasonId,
            previousAccountId,
        );
        expect(result.transferredTaskCount).toBe(0);
        expect(result.transferredDiseaseCaseCount).toBe(2);
    });

    test.each(['COMPLETED', 'CANCELLED'])(
        'rejects replacement when the season is %s',
        async (status) => {
            prisma.aquacultureSeason.findFirst.mockResolvedValue({ ...season, status });

            await expect(seasonService.replacePersonnel(
                seasonId,
                'TECHNICIAN',
                input,
                ownerId,
            )).rejects.toMatchObject({ statusCode: 409 });
            expect(prisma.seasonPersonnelAssignment.updateMany).not.toHaveBeenCalled();
        },
    );

    test('rejects a stale or missing current assignment', async () => {
        prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue(null);

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.account.findFirst).not.toHaveBeenCalled();
    });

    test('rejects replacing the current assignee with the same person', async () => {
        prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({
            id: currentAssignmentId,
            accountId: replacementAccountId,
        });

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.account.findFirst).not.toHaveBeenCalled();
    });

    test('rejects an ineligible replacement account', async () => {
        prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({
            id: currentAssignmentId,
            accountId: previousAccountId,
        });
        prisma.account.findFirst.mockResolvedValue(null);

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 404 });
        expect(prisma.seasonPersonnelAssignment.updateMany).not.toHaveBeenCalled();
    });

    test('rejects a replacement already assigned to the other season role', async () => {
        prisma.seasonPersonnelAssignment.findFirst
            .mockResolvedValueOnce({ id: currentAssignmentId, accountId: previousAccountId })
            .mockResolvedValueOnce({ id: 'existing-assignment' });

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.seasonPersonnelAssignment.updateMany).not.toHaveBeenCalled();
    });

    test('detects a concurrent change while closing the previous assignment', async () => {
        arrangeCurrentAssignment();
        prisma.seasonPersonnelAssignment.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.seasonPersonnelAssignment.create).not.toHaveBeenCalled();
        expect(emitNotification).not.toHaveBeenCalled();
    });

    test('rolls back when the replacement history link cannot be recorded', async () => {
        arrangeCurrentAssignment();
        prisma.seasonPersonnelAssignment.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        await expect(seasonService.replacePersonnel(
            seasonId,
            'TECHNICIAN',
            input,
            ownerId,
        )).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.task.updateMany).not.toHaveBeenCalled();
        expect(prisma.notification.createMany).not.toHaveBeenCalled();
        expect(emitNotification).not.toHaveBeenCalled();
    });

    test.each(['P2002', 'P2003', 'P2034'])(
        'maps replacement Prisma %s to a conflict without realtime notification',
        async (code) => {
            prisma.$transaction.mockRejectedValue({ code });

            await expect(seasonService.replacePersonnel(
                seasonId,
                'TECHNICIAN',
                input,
                ownerId,
            )).rejects.toMatchObject({ statusCode: 409 });
            expect(emitNotification).not.toHaveBeenCalled();
        },
    );
});
