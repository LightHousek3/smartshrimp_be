jest.mock('../src/config/prisma', () => ({
    aquacultureSeason: { findUnique: jest.fn() },
    seasonPersonnelAssignment: { findFirst: jest.fn() },
    waterQualityLog: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
}));
jest.mock('../src/realtime/notification.socket', () => ({ emitNotification: jest.fn() }));
const { Prisma } = require('@prisma/client');
const Joi = require('joi');
const prisma = require('../src/config/prisma');
const service = require('../src/services/waterLog.service');
const validator = require('../src/validators/waterLog.validator');
const { WATER_THRESHOLDS, checkWaterThresholds } = require('../src/constants');
const seasonId = '11111111-1111-4111-8111-111111111111';
let season;
let records;
let tx;
const log = (index, values = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    seasonId, recordedAt: new Date('2026-01-02T00:00:00Z'),
    createdAt: new Date('2026-01-02T00:00:00Z'),
    isVoided: false, ph: new Prisma.Decimal('8.00'), ...values,
});

// In-memory boundary double executes the Prisma predicates, not the service.
// This verifies composition/paging; it does not substitute for SQL/latency QA.
const matches = (row, where) => Object.entries(where).every(([field, condition]) => {
    if (field === 'AND') return condition.every((part) => matches(row, part));
    if (field === 'OR') return condition.some((part) => matches(row, part));
    const raw = row[field];
    const value = raw instanceof Prisma.Decimal ? Number(raw) : raw;
    if (condition instanceof Date) return value?.getTime() === condition.getTime();
    if (condition !== null && typeof condition === 'object') {
        if (value === null || value === undefined) return false;
        return Object.entries(condition).every(([operator, bound]) => ({
            lt: () => value < bound, gt: () => value > bound,
            lte: () => value <= bound, gte: () => value >= bound,
        })[operator]());
    }
    return value === condition;
});
const delegate = () => ({
    findMany: jest.fn(async ({ where, take }) => records.filter((row) => matches(row, where))
        .sort((a, b) => b.recordedAt - a.recordedAt || b.id.localeCompare(a.id)).slice(0, take)),
    count: jest.fn(async ({ where }) => records.filter((row) => matches(row, where)).length),
});
beforeEach(() => {
    jest.resetAllMocks();
    season = { shrimpType: 'WHITELEG', status: 'COMPLETED',
        pond: { isDeleted: false, farm: { isDeleted: false, ownerId: 'owner' } } };
    prisma.aquacultureSeason.findUnique.mockImplementation(async () => season);
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValue({ id: 'assignment' });
    records = Array.from({ length: 120 }, (_, i) => log(120 - i, {
        ph: new Prisma.Decimal(i >= 20 && i < 50 ? '9.00' : '8.00'),
        isVoided: i >= 110,
    }));
    Object.assign(prisma.waterQualityLog, delegate());
    tx = { waterQualityLog: delegate() };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
});

test.each(['ktv', 'expert', 'owner'])('%s filters warnings beyond the first all page and returns scoped counts', async (scope) => {
    const actor = scope === 'owner' ? 'owner' : 'account';
    const all = await service.listWaterLogs(actor, seasonId, { filter: 'all', includeCounts: true }, scope);
    expect(all.logs).toHaveLength(20);
    expect(all.logs.every((row) => row.exceededParameters.length === 0)).toBe(true);
    expect(all.meta.counts).toEqual({ all: 120, valid: 110, warning: 30, voided: 10 });
    const first = await service.listWaterLogs(actor, seasonId, { filter: 'warning', includeCounts: true }, scope);
    expect(first.logs).toHaveLength(20);
    expect(first.logs.every((row) => row.exceededParameters.includes('ph') && !row.isVoided)).toBe(true);
    const second = await service.listWaterLogs(actor, seasonId, { filter: 'warning', cursor: first.meta.nextCursor }, scope);
    expect(second.logs).toHaveLength(10);
    expect(second.meta).toEqual({ totalResults: 30, hasNextPage: false, nextCursor: null });
    expect(new Set([...first.logs, ...second.logs].map((row) => row.id)).size).toBe(30);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
});
test.each([
    [{}, 110], [{ includeVoided: true }, 120], [{ filter: 'all', includeVoided: false }, 120],
    [{ filter: 'warning', includeVoided: true }, 30], [{ filter: 'voided', includeVoided: false }, 10],
])('legacy and explicit filter semantics %j', async (query, totalResults) => {
    expect((await service.listWaterLogs('account', seasonId, query)).meta.totalResults).toBe(totalResults);
    expect(prisma.waterQualityLog.count).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect((await service.listWaterLogs('account', seasonId, { ...query, includeCounts: true })).meta.totalResults).toBe(totalResults);
});
test('snapshot items/counts use the transaction delegate exclusively', async () => {
    await service.listWaterLogs('account', seasonId, { filter: 'voided', includeCounts: true });
    expect(tx.waterQualityLog.findMany).toHaveBeenCalledTimes(1);
    expect(tx.waterQualityLog.count).toHaveBeenCalledTimes(3);
    expect(prisma.waterQualityLog.findMany).not.toHaveBeenCalled();
    expect(prisma.waterQualityLog.count).not.toHaveBeenCalled();
});
test.each(['WHITELEG', 'BLACK_TIGER'])('strict Decimal bounds/null/zero agree with current %s policy for all metrics', async (species) => {
    season.shrimpType = species;
    for (const [field, { min, max }] of Object.entries(WATER_THRESHOLDS[species])) {
        const values = [null, 0, ...(min === null ? [] : [min - 0.00001, min, min + 0.00001]),
            ...(max === null ? [] : [max - 0.00001, max, max + 0.00001])];
        records = values.map((value, index) => log(index, {
            ph: null, [field]: value === null ? null : new Prisma.Decimal(String(value)),
        }));
        const page = await service.listWaterLogs('account', seasonId, { filter: 'warning', includeCounts: true });
        const expected = records.filter((row) => checkWaterThresholds(species, row).length > 0);
        expect(page.meta.totalResults).toBe(expected.length);
        expect(page.logs.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort());
    }
});
test('date/scope/cursor compose independently and counts ignore cursor/filter', async () => {
    records.push(log(200, { seasonId: 'other' }), log(201, { recordedAt: new Date('2026-01-03') }));
    const query = { filter: 'warning', includeCounts: true, from: '2026-01-02', to: '2026-01-02' };
    const first = await service.listWaterLogs('account', seasonId, query);
    const second = await service.listWaterLogs('account', seasonId, { ...query, cursor: first.meta.nextCursor });
    expect(second.meta.counts).toEqual(first.meta.counts);
    expect(second.logs).toHaveLength(10);
    const where = tx.waterQualityLog.findMany.mock.calls[1][0].where;
    expect(where.AND).toHaveLength(3);
    expect(where.AND[1].AND[1].OR.length).toBeGreaterThan(8);
    expect(where.AND[2].OR).toHaveLength(2);
});
test.each([0, 1, 20, 21, 50, 51])('pagination boundary %i records', async (size) => {
    records = records.slice(0, size);
    const page = await service.listWaterLogs('account', seasonId, { filter: 'all', limit: 50 });
    expect(page.logs).toHaveLength(Math.min(size, 50));
    expect(page.meta.totalResults).toBe(size);
    expect(page.meta.hasNextPage).toBe(size > 50);
    expect(page.meta.nextCursor === null).toBe(size <= 50);
});
test('voided warning counted once and changing void status changes both groups', async () => {
    records = [log(1, { ph: 9, temperatureC: 50 })];
    const before = await service.listWaterLogs('account', seasonId, { includeCounts: true });
    expect(before.meta.counts.warning).toBe(1);
    records[0].isVoided = true;
    const after = await service.listWaterLogs('account', seasonId, { includeCounts: true });
    expect(after.meta.counts).toEqual({ all: 1, valid: 0, warning: 0, voided: 1 });
});
test('scope, invalid cursor and database failures propagate without widening access', async () => {
    await expect(service.listWaterLogs('other', seasonId, {}, 'owner')).rejects.toMatchObject({ statusCode: 403 });
    prisma.seasonPersonnelAssignment.findFirst.mockResolvedValueOnce(null);
    await expect(service.listWaterLogs('account', seasonId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.listWaterLogs('account', seasonId, { cursor: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
    tx.waterQualityLog.count.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.listWaterLogs('account', seasonId, { includeCounts: true })).rejects.toThrow('database unavailable');
});
test.each([{ filter: 'invalid' }, { includeCounts: 'yes' }, { includeVoided: 'bad' },
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { from: 'bad' }, { from: '2026-01-03', to: '2026-01-02' }])('invalid query rejected: %j', (query) => {
    expect(Joi.compile(validator.listWaterLogs).validate({ params: { seasonId }, query }).error).toBeDefined();
});
test('query defaults preserve absent filter and convert optional booleans', () => {
    const validate = (query) => Joi.compile(validator.listWaterLogs).validate({ params: { seasonId }, query });
    expect(validate({}).value.query).toEqual({ includeVoided: false, includeCounts: false, limit: 20 });
    expect(validate({ includeCounts: 'true', filter: 'all' }).value.query.includeCounts).toBe(true);
});
