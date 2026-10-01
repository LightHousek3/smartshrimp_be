jest.mock('../../src/config/prisma', () => ({
    $transaction: jest.fn(),
    farm: { findFirst: jest.fn() },
    pond: { findMany: jest.fn(), create: jest.fn() },
}));

const prisma = require('../../src/config/prisma');
const pondService = require('../../src/services/pond.service');

const basePond = {
    id: 'pond-1',
    farmId: 'farm-1',
    name: 'Ao A1',
    areaM2: 1200,
    depthM: 1.5,
    type: 'AQUACULTURE',
    status: 'AVAILABLE',
};

beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.farm.findFirst.mockResolvedValue({ id: 'farm-1' });
    prisma.pond.findMany.mockResolvedValue([]);
    prisma.pond.create.mockImplementation(async ({ data }) => ({
        ...basePond,
        ...data,
    }));
});

test('calculates volume when create input omits it', async () => {
    const result = await pondService.createPond('farm-1', basePond, 'owner-1');

    expect(result.volumeM3).toBe(1800);
    expect(prisma.pond.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ volumeM3: 1800 }),
    }));
});

test('preserves a reasonable supplied volume', async () => {
    const result = await pondService.createPond(
        'farm-1',
        { ...basePond, volumeM3: 1750.25 },
        'owner-1',
    );

    expect(result.volumeM3).toBe(1750.25);
});

test('rejects a supplied volume above area times depth', async () => {
    await expect(pondService.createPond(
        'farm-1',
        { ...basePond, volumeM3: 1800.01 },
        'owner-1',
    )).rejects.toMatchObject({ statusCode: 400 });

    expect(prisma.pond.create).not.toHaveBeenCalled();
});
