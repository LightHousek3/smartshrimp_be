jest.mock('../../src/config/prisma', () => ({
    $transaction: jest.fn(),
    notification: {
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
    },
}));
jest.mock('../../src/realtime/notification.socket', () => ({
    emitNotification: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const { emitNotification } = require('../../src/realtime/notification.socket');
const notificationService = require('../../src/services/notification.service');

beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
});

test('list is scoped to the authenticated account and read filter', async () => {
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.count.mockResolvedValue(0);

    const result = await notificationService.getListNotification('owner-id', {
        readStatus: 'unread',
    });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ accountId: 'owner-id', readAt: null }),
    }));
    expect(result.notifications).toEqual([]);
});

test('opening an owned unread notification records its first read and emits an event', async () => {
    const notification = { id: 'notification-id', readAt: new Date() };
    prisma.notification.updateMany.mockResolvedValue({ count: 1 });
    prisma.notification.findFirst.mockResolvedValue(notification);

    const result = await notificationService.getNotificationById('owner-id', notification.id);

    expect(prisma.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: notification.id, accountId: 'owner-id', readAt: null },
    }));
    expect(result).toBe(notification);
    expect(emitNotification).toHaveBeenCalledWith('owner-id', 'notification:read', {
        id: notification.id,
        readAt: notification.readAt,
    });
});

test('does not reveal another account notification or emit read event', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 0 });
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(notificationService.getNotificationById('owner-id', 'other-id'))
        .rejects.toMatchObject({ statusCode: 404 });
    expect(prisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'other-id', accountId: 'owner-id' },
    }));
    expect(emitNotification).not.toHaveBeenCalled();
});
