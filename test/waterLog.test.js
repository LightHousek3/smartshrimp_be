jest.mock('../src/config/prisma', () => ({
    aquacultureSeason: { findUnique: jest.fn() },
    seasonPersonnelAssignment: { findFirst: jest.fn() },
    waterQualityLog: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
}));
jest.mock('../src/realtime/notification.socket', () => ({ emitNotification: jest.fn() }));

const Joi = require('joi');
const prisma = require('../src/config/prisma');
const { emitNotification } = require('../src/realtime/notification.socket');
const service = require('../src/services/waterLog.service');
const validator = require('../src/validators/waterLog.validator');
const { WATER_THRESHOLDS } = require('../src/constants');
const fixture = require('./fixtures/water-metadata.json');
const seasonId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const recordedAt = new Date('2026-01-02T00:00:00Z');
let season;
let tx;

const makeLog = (data = {}) => ({
    id: '33333333-3333-4333-8333-333333333333', seasonId, recordedBy: accountId,
    recordedAt, createdAt: recordedAt, note: null, isVoided: false,
    voidedBy: null, voidedAt: null, voidReason: null, ...data,
});
beforeEach(() => {
    jest.clearAllMocks();
    season = { id: seasonId, name: 'Season', status: 'ACTIVE', shrimpType: 'WHITELEG',
        pond: { name: 'Pond', farm: { ownerId: 'owner' } } };
    prisma.aquacultureSeason.findUnique.mockImplementation(async () => season);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    tx = { waterQualityLog: { create: jest.fn(async ({ data }) => makeLog(data)) },
        notification: { create: jest.fn(async () => ({ id: 'notification' })) } };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
});

test.each(['WHITELEG', 'BLACK_TIGER'])('metadata for %s matches the shared wire fixture', async (species) => {
    season.shrimpType = species;
    expect(await service.getMetadata(accountId, seasonId)).toEqual(fixture[species]);
});
test.each(['PLANNING', 'ACTIVE', 'COMPLETED', 'CANCELLED'])('reads metadata in %s without opening writes', async (status) => {
    season.status = status;
    expect((await service.getMetadata(accountId, seasonId)).metrics).toHaveLength(8);
    if (status !== 'ACTIVE') {
        await expect(service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8 })).rejects.toMatchObject({ statusCode: 409 });
        prisma.waterQualityLog.findFirst.mockResolvedValue(makeLog());
        await expect(service.voidWaterLog(accountId, seasonId, 'log', 'wrong')).rejects.toMatchObject({ statusCode: 409 });
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.waterQualityLog.update).not.toHaveBeenCalled();
    }
});
test.each(['ktv', 'expert'])('%s needs a current assignment for metadata', async (scope) => {
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue(null);
    await expect(service.getMetadata(accountId, seasonId, scope)).rejects.toMatchObject({ statusCode: 403 });
});
test('owner metadata stays inside farm ownership without removed soft-delete fields', async () => {
    await expect(service.getMetadata('owner', seasonId, 'owner')).resolves.toHaveProperty('shrimpType', 'WHITELEG');
    await expect(service.getMetadata('other', seasonId, 'owner')).rejects.toMatchObject({ statusCode: 403 });
    season = null;
    await expect(service.getMetadata('owner', seasonId, 'owner')).rejects.toMatchObject({ statusCode: 403 });
});
test('missing season and unknown scope never return metadata', async () => {
    season = null;
    await expect(service.getMetadata(accountId, seasonId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getMetadata(accountId, seasonId, 'invalid')).rejects.toMatchObject({ statusCode: 403 });
});
test('log and threshold notification share the transaction; socket emits after commit', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
        const result = await callback(tx);
        expect(emitNotification).not.toHaveBeenCalled();
        return result;
    });
    const result = await service.createWaterLog(accountId, seasonId, { recordedAt, ph: 9 });
    expect(tx.waterQualityLog.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ accountId: 'owner', referenceId: result.log.id }),
    }));
    expect(result.log.exceededParameters).toEqual(['ph']);
    expect(emitNotification).toHaveBeenCalledWith('owner', 'notification:new', { id: 'notification' });
});
test('failed notification rejects the transaction and never emits or caches success', async () => {
    const key = 'rollback';
    tx.notification.create.mockRejectedValueOnce(new Error('notification failed'));
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt, ph: 9 }, key)).rejects.toThrow('notification failed');
    expect(emitNotification).not.toHaveBeenCalled();
    await service.createWaterLog(accountId, seasonId, { recordedAt, ph: 9 }, key);
    expect(tx.waterQualityLog.create).toHaveBeenCalledTimes(2);
});
test('persisted precision is used for both alert and response', async () => {
    tx.waterQualityLog.create.mockResolvedValue(makeLog({ ph: 8.5 }));
    const result = await service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8.504 });
    expect(result.log.ph).toBe(8.5);
    expect(result.log.exceededParameters).toEqual([]);
    expect(tx.notification.create).not.toHaveBeenCalled();
});
test('idempotent replay does not create or emit twice and different payload conflicts', async () => {
    const payload = { recordedAt, ph: 9 };
    const first = await service.createWaterLog(accountId, seasonId, payload, 'replay');
    prisma.waterQualityLog.findUnique.mockResolvedValue(makeLog({ ph: 9 }));
    const second = await service.createWaterLog(accountId, seasonId, payload, 'replay');
    expect(second.log).toEqual(first.log);
    expect(second.duplicate).toBe(true);
    expect(tx.waterQualityLog.create).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledTimes(1);
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8 }, 'replay')).rejects.toMatchObject({ statusCode: 409 });
});
test('simultaneous same-key requests cannot create two logs on this instance', async () => {
    let complete;
    tx.waterQualityLog.create.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const first = service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8 }, 'parallel');
    // Wait for the first transaction to start, rather than relying on a timer.
    while (!complete) await Promise.resolve();
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8 }, 'parallel')).rejects.toMatchObject({ statusCode: 409 });
    complete(makeLog({ ph: 8 }));
    await first;
    expect(tx.waterQualityLog.create).toHaveBeenCalledTimes(1);
});
test('future boundary and duplicate database errors preserve status codes', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt: new Date(now + 300000), ph: 8 })).resolves.toHaveProperty('log');
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt: new Date(now + 300001), ph: 8 })).rejects.toMatchObject({ statusCode: 400 });
    Date.now.mockRestore();
    tx.waterQualityLog.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(service.createWaterLog(accountId, seasonId, { recordedAt, ph: 8 })).rejects.toMatchObject({ statusCode: 409 });
});
test('void preserves metrics and uses a non-voided update predicate', async () => {
    prisma.waterQualityLog.findFirst.mockResolvedValue(makeLog({ ph: 9 }));
    prisma.waterQualityLog.update.mockResolvedValue(makeLog({ ph: 9, isVoided: true, voidedBy: accountId, voidedAt: recordedAt, voidReason: 'wrong' }));
    const log = await service.voidWaterLog(accountId, seasonId, 'log', ' wrong ');
    expect(log.ph).toBe(9);
    expect(log.isVoided).toBe(true);
    expect(prisma.waterQualityLog.update).toHaveBeenCalledWith({
        where: { id: 'log', seasonId, isVoided: false },
        data: expect.objectContaining({ voidReason: 'wrong', voidedBy: accountId }),
    });
    prisma.waterQualityLog.update.mockRejectedValueOnce({ code: 'P2025' });
    await expect(service.voidWaterLog(accountId, seasonId, 'log', 'wrong')).rejects.toMatchObject({ statusCode: 409 });
});
test('statistics exclude voided values and use farm-day/week buckets', async () => {
    prisma.waterQualityLog.findMany.mockResolvedValue([makeLog({ ph: 9 })]);
    prisma.waterQualityLog.count.mockResolvedValue(1);
    const stats = await service.getStatistics(accountId, seasonId, { from: '2026-01-01', to: '2026-01-03' });
    expect(stats.summary).toMatchObject({ totalRecords: 2, validRecords: 1, voidedRecords: 1 });
    expect(stats.summary.parameters.ph.exceedanceRate).toBe(1);
    expect(prisma.waterQualityLog.findMany.mock.calls[0][0].where.isVoided).toBe(false);
    expect(service._bucketKeyOf(new Date('2026-01-01T18:00:00Z'), 'day')).toBe('2026-01-02');
    expect(service._bucketKeyOf(new Date('2026-01-04T18:00:00Z'), 'week')).toBe('2026-01-05');
});
test.each(Object.keys(WATER_THRESHOLDS.WHITELEG))('validator and metadata agree on physical range for %s', async (field) => {
    const metric = fixture.WHITELEG.metrics.find((value) => value.field === field);
    const validate = (value) => Joi.compile(validator.createWaterLog).validate({ params: { seasonId }, body: { recordedAt: recordedAt.toISOString(), [field]: value } });
    expect(validate(metric.inputMin).error).toBeUndefined();
    expect(validate(metric.inputMin - 0.01).error).toBeDefined();
    expect(validate(null).error).toBeDefined();
    if (metric.inputMax !== null) {
        expect(validate(metric.inputMax).error).toBeUndefined();
        expect(validate(metric.inputMax + 0.01).error).toBeDefined();
    }
});
