const mockAdminAccountService = {
    getListAccount: jest.fn(),
    getAccountById: jest.fn(),
    createAccount: jest.fn(),
    resendActivation: jest.fn(),
    updateAccountStatus: jest.fn(),
};

jest.mock('../services', () => ({ adminAccountService: mockAdminAccountService }));
jest.mock('../middlewares', () => {
    const validate = require('../middlewares/validate.middleware');
    const { ApiError } = require('../utils');

    return {
        validate,
        authenticate: (req, res, next) => {
            const authorization = req.headers.authorization;
            if (!authorization) return next(new ApiError(401, 'Unauthorized'));
            req.user = {
                id: '22222222-2222-4222-8222-222222222222',
                role: authorization === 'Bearer farm-owner' ? 'FARM_OWNER' : 'ADMIN',
            };
            return next();
        },
        authorize: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : next(new ApiError(403, 'Forbidden')),
    };
});

const express = require('express');
const request = require('supertest');
const adminAccountRoute = require('./adminAccount.route');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

const app = express();
app.use(express.json());
app.use('/api/v1/admin/accounts', adminAccountRoute);
app.use((error, req, res, next) => {
    void next;
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
});

describe('admin account action routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAdminAccountService.getListAccount.mockResolvedValue({
            accounts: [],
            meta: { limit: 10, totalResults: 0, hasNextPage: false, nextCursor: null },
        });
        mockAdminAccountService.resendActivation.mockResolvedValue({
            email: 'owner@example.com',
            resendAvailableAt: new Date(),
        });
        mockAdminAccountService.updateAccountStatus.mockResolvedValue({
            id: ACCOUNT_ID,
            status: 'INACTIVE',
        });
    });

    test('allows an admin to resend activation', async () => {
        const response = await request(app)
            .post(`/api/v1/admin/accounts/${ACCOUNT_ID}/resend-activation`)
            .set('Authorization', 'Bearer admin');

        expect(response.status).toBe(200);
        expect(mockAdminAccountService.resendActivation).toHaveBeenCalledWith(ACCOUNT_ID);
    });

    test('rejects resend activation without authentication', async () => {
        const response = await request(app).post(
            `/api/v1/admin/accounts/${ACCOUNT_ID}/resend-activation`,
        );

        expect(response.status).toBe(401);
        expect(mockAdminAccountService.resendActivation).not.toHaveBeenCalled();
    });

    test('rejects resend activation for a non-admin actor', async () => {
        const response = await request(app)
            .post(`/api/v1/admin/accounts/${ACCOUNT_ID}/resend-activation`)
            .set('Authorization', 'Bearer farm-owner');

        expect(response.status).toBe(403);
    });

    test('rejects an invalid account id', async () => {
        const response = await request(app)
            .post('/api/v1/admin/accounts/not-a-uuid/resend-activation')
            .set('Authorization', 'Bearer admin');

        expect(response.status).toBe(400);
    });

    test('allows an admin to change account status', async () => {
        const payload = { status: 'INACTIVE', reason: 'Tạm ngừng theo yêu cầu' };
        const response = await request(app)
            .patch(`/api/v1/admin/accounts/${ACCOUNT_ID}/status`)
            .set('Authorization', 'Bearer admin')
            .send(payload);

        expect(response.status).toBe(200);
        expect(mockAdminAccountService.updateAccountStatus).toHaveBeenCalledWith(
            ACCOUNT_ID,
            payload,
            '22222222-2222-4222-8222-222222222222',
        );
    });

    test('rejects pending activation as a manual target status', async () => {
        const response = await request(app)
            .patch(`/api/v1/admin/accounts/${ACCOUNT_ID}/status`)
            .set('Authorization', 'Bearer admin')
            .send({ status: 'PENDING_ACTIVATION', reason: 'Kích hoạt thủ công' });

        expect(response.status).toBe(400);
    });

    test('rejects a reason shorter than five characters', async () => {
        const response = await request(app)
            .patch(`/api/v1/admin/accounts/${ACCOUNT_ID}/status`)
            .set('Authorization', 'Bearer admin')
            .send({ status: 'BLOCKED', reason: '1234' });

        expect(response.status).toBe(400);
    });

    test('accepts a reason at the five-hundred-character boundary', async () => {
        const response = await request(app)
            .patch(`/api/v1/admin/accounts/${ACCOUNT_ID}/status`)
            .set('Authorization', 'Bearer admin')
            .send({ status: 'BLOCKED', reason: 'a'.repeat(500) });

        expect(response.status).toBe(200);
    });

    test('rejects a reason longer than five hundred characters', async () => {
        const response = await request(app)
            .patch(`/api/v1/admin/accounts/${ACCOUNT_ID}/status`)
            .set('Authorization', 'Bearer admin')
            .send({ status: 'BLOCKED', reason: 'a'.repeat(501) });

        expect(response.status).toBe(400);
    });

    test('passes a valid creation-date range to the list service', async () => {
        const response = await request(app)
            .get('/api/v1/admin/accounts')
            .query({
                createdFrom: '2026-09-01T00:00:00.000Z',
                createdTo: '2026-09-11T23:59:59.999Z',
            })
            .set('Authorization', 'Bearer admin');

        expect(response.status).toBe(200);
        expect(mockAdminAccountService.getListAccount).toHaveBeenCalledWith(
            expect.objectContaining({
                createdFrom: expect.any(Date),
                createdTo: expect.any(Date),
            }),
        );
    });

    test('rejects an inverted creation-date range', async () => {
        const response = await request(app)
            .get('/api/v1/admin/accounts')
            .query({
                createdFrom: '2026-09-12T00:00:00.000Z',
                createdTo: '2026-09-11T00:00:00.000Z',
            })
            .set('Authorization', 'Bearer admin');

        expect(response.status).toBe(400);
    });
});
