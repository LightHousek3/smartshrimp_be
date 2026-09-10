const mockPrisma = {
    user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    emailVerificationChallenge: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
    },
    farm: { findMany: jest.fn() },
    pond: { findMany: jest.fn() },
    aquacultureSeason: { count: jest.fn() },
    seasonPersonnelAssignment: { findMany: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock('../config/prisma', () => mockPrisma);
jest.mock('./email.service', () => ({
    sendAccountActivationEmail: jest.fn(),
}));

const emailService = require('./email.service');
const adminAccountService = require('./adminAccount.service');
const { ACCOUNT_STATUS, USER_ROLE } = require('../constants');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const NOW_PLUS_MINUTE = new Date(Date.now() + 60000);

const account = (overrides = {}) => ({
    id: ACCOUNT_ID,
    email: 'owner@example.com',
    role: USER_ROLE.FARM_OWNER,
    status: ACCOUNT_STATUS.ACTIVE,
    ...overrides,
});

describe('adminAccountService account actions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.$transaction.mockImplementation((callback) => callback(mockPrisma));
        mockPrisma.emailVerificationChallenge.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.farm.findMany.mockResolvedValue([]);
        mockPrisma.pond.findMany.mockResolvedValue([]);
        mockPrisma.aquacultureSeason.count.mockResolvedValue(0);
        mockPrisma.seasonPersonnelAssignment.findMany.mockResolvedValue([]);
        mockPrisma.user.count.mockResolvedValue(0);
        mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
        emailService.sendAccountActivationEmail.mockResolvedValue({ messageId: 'mail-1' });
    });

    describe('resendActivation', () => {
        test('creates a new challenge and sends a six-digit activation code', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(
                account({ status: ACCOUNT_STATUS.PENDING_ACTIVATION }),
            );
            mockPrisma.emailVerificationChallenge.findFirst.mockResolvedValue(null);
            mockPrisma.emailVerificationChallenge.create.mockResolvedValue({
                id: 'challenge-1',
                expiresAt: NOW_PLUS_MINUTE,
                resendAvailableAt: NOW_PLUS_MINUTE,
            });

            const result = await adminAccountService.resendActivation(ACCOUNT_ID);

            const challengeData = mockPrisma.emailVerificationChallenge.create.mock.calls[0][0].data;
            const mailData = emailService.sendAccountActivationEmail.mock.calls[0][0];
            expect(challengeData.codeHash).toMatch(/^[a-f0-9]{64}$/);
            expect(mailData.code).toMatch(/^\d{6}$/);
            expect(result.email).toBe('owner@example.com');
        });

        test('rejects an unknown account', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(null);

            await expect(adminAccountService.resendActivation(ACCOUNT_ID)).rejects.toMatchObject({
                statusCode: 404,
            });
        });

        test('rejects an account that is not pending activation', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account());

            await expect(adminAccountService.resendActivation(ACCOUNT_ID)).rejects.toMatchObject({
                statusCode: 409,
            });
        });

        test('enforces the sixty-second resend cooldown', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(
                account({ status: ACCOUNT_STATUS.PENDING_ACTIVATION }),
            );
            mockPrisma.emailVerificationChallenge.findFirst.mockResolvedValue({
                resendAvailableAt: NOW_PLUS_MINUTE,
            });

            await expect(adminAccountService.resendActivation(ACCOUNT_ID)).rejects.toMatchObject({
                statusCode: 429,
            });
            expect(emailService.sendAccountActivationEmail).not.toHaveBeenCalled();
        });

        test('invalidates the new challenge when email delivery fails', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(
                account({ status: ACCOUNT_STATUS.PENDING_ACTIVATION }),
            );
            mockPrisma.emailVerificationChallenge.findFirst.mockResolvedValue(null);
            mockPrisma.emailVerificationChallenge.create.mockResolvedValue({
                id: 'challenge-1',
                expiresAt: NOW_PLUS_MINUTE,
                resendAvailableAt: NOW_PLUS_MINUTE,
            });
            emailService.sendAccountActivationEmail.mockRejectedValue(new Error('SMTP unavailable'));

            await expect(adminAccountService.resendActivation(ACCOUNT_ID)).rejects.toMatchObject({
                statusCode: 503,
            });
            expect(mockPrisma.emailVerificationChallenge.updateMany).toHaveBeenLastCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ id: 'challenge-1' }) }),
            );
        });

        test('maps a concurrent active-challenge conflict to the resend cooldown', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(
                account({ status: ACCOUNT_STATUS.PENDING_ACTIVATION }),
            );
            mockPrisma.emailVerificationChallenge.findFirst.mockResolvedValue(null);
            mockPrisma.$transaction.mockRejectedValue({ code: 'P2002' });

            await expect(adminAccountService.resendActivation(ACCOUNT_ID)).rejects.toMatchObject({
                statusCode: 429,
            });
        });
    });

    describe('updateAccountStatus', () => {
        test('deactivates eligible staff and revokes all active refresh tokens', async () => {
            const activeStaff = account({ role: USER_ROLE.TECHNICIAN });
            const updated = { ...activeStaff, status: ACCOUNT_STATUS.INACTIVE };
            mockPrisma.user.findUnique.mockResolvedValue(activeStaff);
            mockPrisma.user.update.mockResolvedValue(updated);

            const result = await adminAccountService.updateAccountStatus(
                ACCOUNT_ID,
                { status: ACCOUNT_STATUS.INACTIVE, reason: 'Tạm ngừng theo yêu cầu' },
                ADMIN_ID,
            );

            expect(mockPrisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: ACCOUNT_STATUS.INACTIVE,
                        statusChangedBy: ADMIN_ID,
                    }),
                }),
            );
            expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalled();
            expect(result).toEqual(updated);
        });

        test('reactivates a blocked account without revoking tokens', async () => {
            const blocked = account({ status: ACCOUNT_STATUS.BLOCKED });
            mockPrisma.user.findUnique.mockResolvedValue(blocked);
            mockPrisma.user.update.mockResolvedValue({ ...blocked, status: ACCOUNT_STATUS.ACTIVE });

            await adminAccountService.updateAccountStatus(
                ACCOUNT_ID,
                { status: ACCOUNT_STATUS.ACTIVE, reason: 'Đã xác minh lại tài khoản' },
                ADMIN_ID,
            );

            expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
        });

        test('rejects a pending account transition', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(
                account({ status: ACCOUNT_STATUS.PENDING_ACTIVATION }),
            );

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.ACTIVE, reason: 'Kích hoạt thủ công' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
        });

        test('rejects a status change for an unknown account', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(null);

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.BLOCKED, reason: 'Khóa tài khoản vi phạm' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 404 });
        });

        test('rejects an unchanged status', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account());

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.ACTIVE, reason: 'Không thay đổi' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
        });

        test('rejects deactivation when staff has an open-season assignment', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account({ role: USER_ROLE.EXPERT }));
            mockPrisma.seasonPersonnelAssignment.findMany.mockResolvedValue([
                { seasonId: 'season-1' },
            ]);
            mockPrisma.aquacultureSeason.count.mockResolvedValue(1);

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.BLOCKED, reason: 'Khóa tài khoản vi phạm' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
        });

        test('rejects deactivation when an owner still has active staff', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account());
            mockPrisma.user.count.mockResolvedValue(1);

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.INACTIVE, reason: 'Dừng vận hành trang trại' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
        });

        test('rejects deactivation when an owner has an open season', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account());
            mockPrisma.farm.findMany.mockResolvedValue([{ id: 'farm-1' }]);
            mockPrisma.pond.findMany.mockResolvedValue([{ id: 'pond-1' }]);
            mockPrisma.aquacultureSeason.count.mockResolvedValue(1);

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.INACTIVE, reason: 'Dừng vận hành trang trại' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 409 });
        });

        test('rejects changes to an admin account', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(account({ role: USER_ROLE.ADMIN }));

            await expect(
                adminAccountService.updateAccountStatus(
                    ACCOUNT_ID,
                    { status: ACCOUNT_STATUS.BLOCKED, reason: 'Không được phép' },
                    ADMIN_ID,
                ),
            ).rejects.toMatchObject({ statusCode: 400 });
        });
    });
});
