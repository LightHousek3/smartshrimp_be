jest.mock('../../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
}));
jest.mock('../../src/services', () => ({
    seasonService: {
        assignPersonnel: jest.fn(),
        replacePersonnel: jest.fn(),
    },
}));
jest.mock('../../src/middlewares/auth.middleware', () => {
    const { ApiError } = require('../../src/utils');
    const { messages } = require('../../src/constants');

    const authenticate = (req, res, next) => {
        const authorization = req.get('authorization');
        if (authorization === 'Bearer owner-token') {
            req.account = {
                id: '11111111-1111-4111-8111-111111111111',
                role: 'FARM_OWNER',
            };
            return next();
        }
        if (authorization === 'Bearer staff-token') {
            req.account = {
                id: '99999999-9999-4999-8999-999999999999',
                role: 'TECHNICIAN',
            };
            return next();
        }
        return next(ApiError.unauthorized(messages.AUTH.UNAUTHORIZED));
    };

    const authorize = (...roles) => (req, res, next) => {
        if (!roles.includes(req.account?.role)) {
            return next(ApiError.forbidden(messages.AUTH.FORBIDDEN));
        }
        return next();
    };

    return { authenticate, authorize, optionalAuth: (req, res, next) => next() };
});

const express = require('express');
const request = require('supertest');
const { ApiError } = require('../../src/utils');
const { seasonService } = require('../../src/services');
const seasonRoute = require('../../src/routes/season.route');
const { errorConverter, errorHandler } = require('../../src/middlewares/error.middleware');

const ownerId = '11111111-1111-4111-8111-111111111111';
const seasonId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const expectedAssignmentId = '44444444-4444-4444-8444-444444444444';

const app = express();
app.use(express.json());
app.use('/api/v1/owner/seasons', seasonRoute);
app.use(errorConverter);
app.use(errorHandler);

beforeEach(() => {
    jest.clearAllMocks();
});

test('POST assignment returns 201 and forwards validated input to the service', async () => {
    const assignment = { id: 'assignment-id', seasonId, role: 'TECHNICIAN' };
    seasonService.assignPersonnel.mockResolvedValue(assignment);

    const response = await request(app)
        .post(`/api/v1/owner/seasons/${seasonId}/personnel-assignments`)
        .set('Authorization', 'Bearer owner-token')
        .send({ accountId, role: 'TECHNICIAN' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
        success: true,
        message: 'Phân công nhân sự vào vụ nuôi thành công',
        data: assignment,
    });
    expect(seasonService.assignPersonnel).toHaveBeenCalledWith(
        seasonId,
        { accountId, role: 'TECHNICIAN' },
        ownerId,
    );
});

test('POST replacement returns 200 and forwards trimmed reason to the service', async () => {
    const result = {
        assignment: { id: 'new-assignment-id' },
        transferredTaskCount: 2,
        transferredDiseaseCaseCount: 0,
    };
    seasonService.replacePersonnel.mockResolvedValue(result);

    const response = await request(app)
        .post(
            `/api/v1/owner/seasons/${seasonId}`
            + '/personnel-assignments/TECHNICIAN/replace',
        )
        .set('Authorization', 'Bearer owner-token')
        .send({
            accountId,
            expectedAssignmentId,
            reason: '  Điều chuyển công việc  ',
        });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
        success: true,
        message: 'Thay nhân sự phụ trách vụ nuôi thành công',
        data: result,
    });
    expect(seasonService.replacePersonnel).toHaveBeenCalledWith(
        seasonId,
        'TECHNICIAN',
        {
            accountId,
            expectedAssignmentId,
            reason: 'Điều chuyển công việc',
        },
        ownerId,
    );
});

test('rejects malformed assignment and replacement requests before the service', async () => {
    const assignmentResponse = await request(app)
        .post(`/api/v1/owner/seasons/${seasonId}/personnel-assignments`)
        .set('Authorization', 'Bearer owner-token')
        .send({ accountId: 'invalid', role: 'FARM_OWNER' });
    const replacementResponse = await request(app)
        .post(
            `/api/v1/owner/seasons/${seasonId}`
            + '/personnel-assignments/TECHNICIAN/replace',
        )
        .set('Authorization', 'Bearer owner-token')
        .send({ accountId, expectedAssignmentId, reason: ' ' });

    expect(assignmentResponse.status).toBe(400);
    expect(replacementResponse.status).toBe(400);
    expect(seasonService.assignPersonnel).not.toHaveBeenCalled();
    expect(seasonService.replacePersonnel).not.toHaveBeenCalled();
});

test('requires authentication for both personnel assignment endpoints', async () => {
    const assignmentResponse = await request(app)
        .post(`/api/v1/owner/seasons/${seasonId}/personnel-assignments`)
        .send({ accountId, role: 'TECHNICIAN' });
    const replacementResponse = await request(app)
        .post(
            `/api/v1/owner/seasons/${seasonId}`
            + '/personnel-assignments/TECHNICIAN/replace',
        )
        .send({ accountId, expectedAssignmentId, reason: 'Điều chuyển' });

    expect(assignmentResponse.status).toBe(401);
    expect(replacementResponse.status).toBe(401);
});

test('forbids a non-owner from both personnel assignment endpoints', async () => {
    const assignmentResponse = await request(app)
        .post(`/api/v1/owner/seasons/${seasonId}/personnel-assignments`)
        .set('Authorization', 'Bearer staff-token')
        .send({ accountId, role: 'TECHNICIAN' });
    const replacementResponse = await request(app)
        .post(
            `/api/v1/owner/seasons/${seasonId}`
            + '/personnel-assignments/TECHNICIAN/replace',
        )
        .set('Authorization', 'Bearer staff-token')
        .send({ accountId, expectedAssignmentId, reason: 'Điều chuyển' });

    expect(assignmentResponse.status).toBe(403);
    expect(replacementResponse.status).toBe(403);
});

test('preserves service conflict errors in the replacement API response', async () => {
    seasonService.replacePersonnel.mockRejectedValue(
        ApiError.conflict('Nhân sự phụ trách hiện tại đã thay đổi'),
    );

    const response = await request(app)
        .post(
            `/api/v1/owner/seasons/${seasonId}`
            + '/personnel-assignments/EXPERT/replace',
        )
        .set('Authorization', 'Bearer owner-token')
        .send({ accountId, expectedAssignmentId, reason: 'Điều chuyển' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
        success: false,
        statusCode: 409,
        message: 'Nhân sự phụ trách hiện tại đã thay đổi',
    });
});
