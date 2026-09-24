jest.mock('../../src/config/prisma', () => ({
    $transaction: jest.fn(),
    account: { create: jest.fn() },
    emailVerificationChallenge: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
    },
}));
jest.mock('../../src/services/email.service', () => ({
    sendAccountActivationEmail: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const emailService = require('../../src/services/email.service');
const adminAccountService = require('../../src/services/adminAccount.service');

const account = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'new-owner@example.com',
    role: 'FARM_OWNER',
    status: 'PENDING_ACTIVATION',
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.account.create.mockResolvedValue(account);
    prisma.emailVerificationChallenge.findFirst.mockResolvedValue(null);
    prisma.emailVerificationChallenge.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailVerificationChallenge.create.mockResolvedValue({
        id: 'challenge-id',
        expiresAt: new Date('2026-09-24T10:10:00Z'),
        resendAvailableAt: new Date('2026-09-24T10:01:00Z'),
    });
});

test('reports a committed account even if the invitation email fails', async () => {
    emailService.sendAccountActivationEmail.mockRejectedValue(new Error('SMTP unavailable'));

    const result = await adminAccountService.createAccount({
        email: account.email,
        role: account.role,
    }, 'admin-id');

    expect(result).toEqual({
        ...account,
        activation: null,
        activationEmailSent: false,
    });
    expect(prisma.account.create).toHaveBeenCalledTimes(1);
    expect(prisma.emailVerificationChallenge.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: 'challenge-id' }),
    }));
});

test('returns activation details when the invitation email is sent', async () => {
    emailService.sendAccountActivationEmail.mockResolvedValue(undefined);

    const result = await adminAccountService.createAccount({
        email: account.email,
        role: account.role,
    }, 'admin-id');

    expect(result.activationEmailSent).toBe(true);
    expect(result.activation).toEqual({
        email: account.email,
        expiresAt: new Date('2026-09-24T10:10:00Z'),
        resendAvailableAt: new Date('2026-09-24T10:01:00Z'),
    });
});
