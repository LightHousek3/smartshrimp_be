jest.mock('../src/config/prisma', () => ({
    farm: { findMany: jest.fn(), findFirst: jest.fn() },
    pond: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
}));
const prisma = require('../src/config/prisma');
const farmService = require('../src/services/farm.service');
const pondService = require('../src/services/pond.service');
const { messages } = require('../src/constants');
let tx;
const farm = { id: 'farm', ownerId: 'owner', name: 'Farm', latitude: '10', ponds: [] };
const pond = { id: 'pond', farmId: 'farm', name: 'Pond', areaM2: '1200', type: 'AQUACULTURE', status: 'AVAILABLE' };
beforeEach(() => {
    jest.resetAllMocks();
    tx = {
        farm: { findFirst: jest.fn(async () => farm), deleteMany: jest.fn(async () => ({ count: 1 })) },
        pond: { findFirst: jest.fn(async () => pond), deleteMany: jest.fn(async () => ({ count: 1 })) },
        aquacultureSeason: { count: jest.fn(async () => 0) },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
});
for (const entity of ['farm', 'pond']) {
    const run = () => entity === 'farm' ? farmService.deleteFarm('farm', 'owner') : pondService.deletePond('farm', 'pond', 'owner');
    const where = entity === 'farm' ? { id: 'farm', ownerId: 'owner' } : { id: 'pond', farmId: 'farm' };
    test(`${entity} physically deletes only the owned row and returns its snapshot`, async () => {
        const result = await run();
        expect(result.id).toBe(entity);
        expect(tx[entity].deleteMany).toHaveBeenCalledWith({ where });
        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
        expect(Object.keys(tx).sort()).toEqual(['aquacultureSeason', 'farm', 'pond']);
        expect(tx[entity === 'farm' ? 'pond' : 'farm'].deleteMany).not.toHaveBeenCalled();
        expect(prisma.farm.findFirst).not.toHaveBeenCalled();
        expect(prisma.pond.findFirst).not.toHaveBeenCalled();
        expect(JSON.stringify(tx[entity].findFirst.mock.calls)).not.toMatch(/isDeleted|deletedAt/);
        expect(result).not.toHaveProperty('deletedAt');
    });
    test(`${entity} cannot delete another owner's or missing row`, async () => {
        tx[entity].findFirst.mockResolvedValueOnce(null);
        await expect(run()).rejects.toMatchObject({ statusCode: 404 });
        expect(tx[entity].deleteMany).not.toHaveBeenCalled();
    });
    test(`${entity} still blocks an open season before attempting DELETE`, async () => {
        tx.aquacultureSeason.count.mockResolvedValueOnce(1);
        await expect(run()).rejects.toMatchObject({ statusCode: 409 });
        expect(tx[entity].deleteMany).not.toHaveBeenCalled();
    });
    test(`${entity} maps FK restriction to 409 and leaves all children alone`, async () => {
        tx[entity].deleteMany.mockRejectedValueOnce({ code: 'P2003' });
        await expect(run()).rejects.toMatchObject({ statusCode: 409, message: messages[entity.toUpperCase()].HAS_REFERENCES });
        expect(tx[entity === 'farm' ? 'pond' : 'farm'].deleteMany).not.toHaveBeenCalled();
    });
    test.each(['P2034', 'zero'])('%s concurrency error remains a conflict', async (failure) => {
        if (failure === 'zero') tx[entity].deleteMany.mockResolvedValueOnce({ count: 0 });
        else tx[entity].deleteMany.mockRejectedValueOnce({ code: failure });
        await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    });
    test(`${entity} propagates unexpected database errors`, async () => {
        tx[entity].deleteMany.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(run()).rejects.toThrow('database unavailable');
    });
}
test('farm read and pond read query only actual fields and retain owner scope', async () => {
    prisma.farm.findMany.mockResolvedValueOnce([farm]);
    const farms = await farmService.getListFarm('owner');
    expect(farms[0].latitude).toBe(10);
    expect(prisma.farm.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'owner' });
    prisma.farm.findFirst.mockResolvedValueOnce(farm);
    prisma.pond.findMany.mockResolvedValueOnce([pond]);
    prisma.pond.count.mockResolvedValueOnce(1);
    const ponds = await pondService.getPonds('farm', 'owner', { page: 1, limit: 20, status: 'INACTIVE' });
    expect(ponds.ponds[0].areaM2).toBe(1200);
    expect(prisma.farm.findFirst.mock.calls[0][0].where).toEqual({ id: 'farm', ownerId: 'owner' });
    expect(prisma.pond.findMany.mock.calls[0][0].where).toEqual({ farmId: 'farm', status: 'INACTIVE' });
    expect(JSON.stringify([prisma.farm.findMany.mock.calls, prisma.pond.findMany.mock.calls])).not.toMatch(/isDeleted|deletedAt/);
});
