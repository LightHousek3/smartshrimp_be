const pondValidator = require('../../src/validators/pond.validator');

const farmId = '123e4567-e89b-42d3-a456-426614174000';

describe('pond write validation', () => {
    const validBody = {
        name: 'Ao A1',
        areaM2: 1200,
        depthM: 1.5,
    };

    test('allows create volume to be omitted', () => {
        const { error, value } = pondValidator.createPond.body.validate(validBody);

        expect(error).toBeUndefined();
        expect(value.volumeM3).toBeUndefined();
    });

    test('accepts a positive create volume with at most two decimal places', () => {
        const { error } = pondValidator.createPond.body.validate({
            ...validBody,
            volumeM3: 1750.25,
        });

        expect(error).toBeUndefined();
    });

    test.each([0, -1, 1.234, 1000000000000])('rejects invalid volume %s', (volumeM3) => {
        const { error } = pondValidator.createPond.body.validate({ ...validBody, volumeM3 });

        expect(error).toBeDefined();
    });

    test('allows volume in an update body', () => {
        const { error } = pondValidator.updatePond.body.validate({ volumeM3: 900 });

        expect(error).toBeUndefined();
    });

    test('validates route ids independently from the optional volume', () => {
        const { error } = pondValidator.createPond.params.validate({ farmId });

        expect(error).toBeUndefined();
    });
});
