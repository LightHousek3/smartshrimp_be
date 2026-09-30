const Joi = require('joi');
const seasonValidator = require('../../src/validators/season.validator');

const seasonId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const expectedAssignmentId = '44444444-4444-4444-8444-444444444444';

const validate = (schema, params, body) => Joi.compile(schema).validate(
    { params, body },
    { abortEarly: false },
);

test.each(['TECHNICIAN', 'EXPERT'])('accepts assignment role %s', (role) => {
    const result = validate(
        seasonValidator.assignPersonnel,
        { seasonId },
        { accountId, role },
    );
    expect(result.error).toBeUndefined();
});

test('rejects invalid assignment UUID, role, and unknown fields', () => {
    expect(validate(
        seasonValidator.assignPersonnel,
        { seasonId },
        { accountId: 'invalid', role: 'FARM_OWNER', unknown: true },
    ).error).toBeDefined();
});

test.each(['TECHNICIAN', 'EXPERT'])('accepts replacement role %s and trims its reason', (role) => {
    const result = validate(
        seasonValidator.replacePersonnel,
        { seasonId, role },
        { accountId, expectedAssignmentId, reason: '  Điều chuyển công việc  ' },
    );
    expect(result.error).toBeUndefined();
    expect(result.value.body.reason).toBe('Điều chuyển công việc');
});

test('rejects replacement with an empty reason', () => {
    expect(validate(
        seasonValidator.replacePersonnel,
        { seasonId, role: 'TECHNICIAN' },
        { accountId, expectedAssignmentId, reason: '   ' },
    ).error).toBeDefined();
});

test('accepts a replacement reason at the 2000-character boundary', () => {
    expect(validate(
        seasonValidator.replacePersonnel,
        { seasonId, role: 'TECHNICIAN' },
        { accountId, expectedAssignmentId, reason: 'a'.repeat(2000) },
    ).error).toBeUndefined();
});

test('rejects a replacement reason above the 2000-character boundary', () => {
    expect(validate(
        seasonValidator.replacePersonnel,
        { seasonId, role: 'TECHNICIAN' },
        { accountId, expectedAssignmentId, reason: 'a'.repeat(2001) },
    ).error).toBeDefined();
});

test('rejects invalid replacement role, assignment UUID, and unknown fields', () => {
    expect(validate(
        seasonValidator.replacePersonnel,
        { seasonId, role: 'FARM_OWNER' },
        {
            accountId,
            expectedAssignmentId: 'invalid',
            reason: 'Điều chuyển',
            unknown: true,
        },
    ).error).toBeDefined();
});
