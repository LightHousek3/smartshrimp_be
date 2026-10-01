jest.mock('../../src/config/prisma', () => ({
    $transaction: jest.fn(),
    emailVerificationChallenge: { findUnique: jest.fn() },
}));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('password-hash') }));
jest.mock('../../src/services/email.service', () => ({}));
jest.mock('../../src/services/token.service', () => ({}));
jest.mock('../../src/config/logger', () => ({}));
jest.mock('../../src/realtime/notification.socket', () => ({ emitNotification: jest.fn() }));

const prisma = require('../../src/config/prisma');
const { emitNotification } = require('../../src/realtime/notification.socket');
const { activateAccount } = require('../../src/services/verification.service');

let transaction;
let challenge;
const input = { actionToken: 'action-token', fullName: 'Nhân sự mới', password: 'password' };

beforeEach(() => {
    jest.clearAllMocks();
    challenge = {
        id: 'challenge-id',
        accountId: 'staff-id',
        purpose: 'ACCOUNT_ACTIVATION',
        verifiedAt: new Date(),
        actionTokenExpiresAt: new Date(Date.now() + 60000),
        account: {
            role: 'TECHNICIAN', status: 'PENDING_ACTIVATION',
            activatedAt: null, passwordHash: null, managedByOwnerId: 'owner-id',
        },
    };
    transaction = {
        emailVerificationChallenge: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        account: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        notification: { create: jest.fn().mockResolvedValue({ id: 'notification-id' }) },
    };
    prisma.emailVerificationChallenge.findUnique.mockResolvedValue(challenge);
    prisma.$transaction.mockImplementation(async (callback) => callback(transaction));
});

test.each(['TECHNICIAN', 'EXPERT'])('activation notifies the owner with the %s account reference', async (role) => {
    challenge.account.role = role;
    await activateAccount(input);

    expect(transaction.notification.create).toHaveBeenCalledWith({
        data: {
            accountId: 'owner-id',
            title: 'Nhân sự đã kích hoạt tài khoản',
            content: expect.stringContaining(input.fullName),
            type: 'MANAGED_ACCOUNT_ACTIVATED',
            referenceType: 'account', referenceId: 'staff-id',
        },
        select: { id: true },
    });
    expect(emitNotification).toHaveBeenCalledWith('owner-id', 'notification:new', { id: 'notification-id' });
});

test.each(['FARM_OWNER', 'TECHNICIAN'])('does not notify an owner for unmanaged %s activation', async (role) => {
    challenge.account.role = role;
    challenge.account.managedByOwnerId = null;
    await activateAccount(input);
    expect(transaction.notification.create).not.toHaveBeenCalled();
    expect(emitNotification).not.toHaveBeenCalled();
});

test('does not create a notification when activation loses a concurrent update', async () => {
    transaction.account.updateMany.mockResolvedValue({ count: 0 });
    await expect(activateAccount(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(transaction.notification.create).not.toHaveBeenCalled();
    expect(emitNotification).not.toHaveBeenCalled();
});

test('does not emit a notification if the activation transaction fails to commit', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
        await callback(transaction);
        throw new Error('Commit failed');
    });
    await expect(activateAccount(input)).rejects.toThrow('Commit failed');
    expect(emitNotification).not.toHaveBeenCalled();
});

test('propagates notification persistence failure through the activation transaction', async () => {
    transaction.notification.create.mockRejectedValue(new Error('Insert failed'));
    await expect(activateAccount(input)).rejects.toThrow('Insert failed');
    expect(emitNotification).not.toHaveBeenCalled();
});
