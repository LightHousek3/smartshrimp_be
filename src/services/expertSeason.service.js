const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { readProfessionalHistory } = require('./harvest.service');
const { ApiError } = require('../utils');
const { PERSONNEL_ROLE, SEASON_STATUS, ACCOUNT_ROLE, ACCOUNT_STATUS, WATER_THRESHOLDS, messages } = require('../constants');
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const localDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Represent the Vietnam calendar day as UTC midnight so day differences ignore server timezone. */
const localDayStamp = (date) => {
    const parts = Object.fromEntries(localDate.formatToParts(date)
        .filter(({ type }) => ['year', 'month', 'day'].includes(type))
        .map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day);
};

/**
 * Stocking day is DOC 1; planning seasons and missing stocking dates have no DOC.
 * Ended seasons use the actual end date, falling back to their last update day.
 */
const dayOfCulture = (season, now) => {
    if (season.status === SEASON_STATUS.PLANNING || !season.stockingDate) return null;
    const end = season.status === SEASON_STATUS.ACTIVE
        ? localDayStamp(now)
        : (season.actualEndDate?.getTime() ?? localDayStamp(season.updatedAt));
    return Math.max(0, Math.floor((end - season.stockingDate.getTime()) / MILLISECONDS_PER_DAY) + 1);
};

/**
 * Open seasons require a current expert assignment; ended seasons retain historical access.
 */
const assignmentScope = (accountId) => {
    const participant = { accountId, role: PERSONNEL_ROLE.EXPERT };
    return { OR: [
        {
            status: { in: [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE] },
            personnelAssignments: { some: { ...participant, unassignedAt: null } },
        },
        {
            status: { in: [SEASON_STATUS.COMPLETED, SEASON_STATUS.CANCELLED] },
            personnelAssignments: { some: participant },
        },
    ] };
};

/** Search and filters narrow the assignment scope without granting access to other seasons. */
const assignedSeasonWhere = (accountId, query = {}) => ({
    AND: [
        assignmentScope(accountId),
        ...(query.status ? [{ status: query.status }] : []),
        ...(query.shrimpType ? [{ shrimpType: query.shrimpType }] : []),
        ...(query.farmId ? [{ pond: { farmId: query.farmId } }] : []),
        ...(query.search ? [{ OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { pond: { name: { contains: query.search, mode: 'insensitive' } } },
            { pond: { farm: { name: { contains: query.search, mode: 'insensitive' } } } },
        ] }] : []),
    ],
});

/**
 * Load only list context, unresolved case severities and the latest production version.
 * The latest version may be a draft or rejected protocol, rather than the approved one.
 */
const seasonSelect = {
    id: true, name: true, status: true, shrimpType: true,
    stockingDate: true, actualEndDate: true, updatedAt: true,
    pond: { select: {
        name: true,
        farm: { select: { name: true } },
    } },
    protocols: {
        where: { protocolType: 'PRODUCTION' },
        orderBy: [{ versionNo: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { status: true, versionNo: true },
    },
    diseaseCases: {
        where: { status: { not: 'RESOLVED' } },
        select: { severity: true },
    },
};

const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Return list summaries with date-only stocking dates and the highest unresolved case severity. */
const normalizeSeason = (season, now) => ({
    id: season.id,
    name: season.name,
    pondName: season.pond.name,
    farm: { name: season.pond.farm.name },
    shrimpType: season.shrimpType,
    dayOfCulture: dayOfCulture(season, now),
    stockingDate: season.stockingDate?.toISOString().slice(0, 10) ?? null,
    status: season.status,
    productionProtocol: season.protocols[0] ?? null,
    openCaseCount: season.diseaseCases.length,
    highestOpenSeverity: season.diseaseCases.reduce((highest, item) => (
        SEVERITY_RANK[item.severity] > (SEVERITY_RANK[highest] ?? 0) ? item.severity : highest
    ), null),
});

/**
 * List scoped seasons with deterministic pagination and a shared timestamp for DOC calculation.
 * Farm filter options use the full assignment scope so active filters do not hide other choices.
 * Open-season access needs a current assignment; ended-season access can follow historical participation.
 */
const getAssignedSeasons = async (accountId, query = {}, now = new Date()) => {
    const { page = 1, limit = 10 } = query;
    const where = assignedSeasonWhere(accountId, query);
    const [totalResults, farms] = await Promise.all([
        prisma.aquacultureSeason.count({ where }),
        prisma.farm.findMany({
            where: {
                ponds: { some: {
                    seasons: { some: assignmentScope(accountId) },
                } },
            },
            select: { id: true, name: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
    ]);

    const seasons = await prisma.aquacultureSeason.findMany({
        where,
        select: seasonSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
    });

    return {
        seasons: seasons.map((season) => normalizeSeason(season, now)),
        meta: { page, limit, totalResults, farms },
    };
};

const toNumber = (value) => (value == null ? null : Number(value));
const dateOnly = (value) => value?.toISOString().slice(0, 10) ?? null;
const round = (value, scale) => Number(value.toFixed(scale));

/** Only fields rendered by the detail header and stocking card cross the API boundary. */
const detailSelect = {
    id: true, name: true, status: true, shrimpType: true, stockingDate: true,
    expectedEndDate: true, actualEndDate: true, updatedAt: true,
    initialQuantity: true, initialDensityPerM2: true,
    pond: { select: {
        name: true, areaM2: true, volumeM3: true,
        farm: { select: { name: true } },
    } },
    personnelAssignments: {
        where: { role: PERSONNEL_ROLE.TECHNICIAN },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        select: { unassignedAt: true, account: { select: { fullName: true, phone: true } } },
    },
    _count: { select: { diseaseCases: { where: { status: { not: 'RESOLVED' } } } } },
};

/** Growth compares actual weighing days within the current post-partial-harvest cohort. */
const normalizeGrowth = (season, logs, latestHarvest) => {
    const samples = logs.filter((log) => log.avgWeightG != null);
    const latest = samples.at(-1);
    if (!latest) return null;
    const weight = toNumber(latest?.avgWeightG);
    const afterBoundary = (sample) => !latestHarvest || sample.recordedAt > latestHarvest.harvested_at;
    const previous = latestHarvest?.harvest_type !== 'final' && afterBoundary(latest) && samples.findLast((sample) => (
        afterBoundary(sample) && localDayStamp(sample.recordedAt) < localDayStamp(latest.recordedAt)
    ));
    const elapsedDays = previous ? (localDayStamp(latest.recordedAt) - localDayStamp(previous.recordedAt)) / MILLISECONDS_PER_DAY : 0;
    // Keep the last actual observation on each DOC; do not invent interpolated samples.
    const daily = new Map();
    for (const sample of samples) {
        if (!season.stockingDate) break;
        const doc = Math.floor((localDayStamp(sample.recordedAt) - season.stockingDate.getTime()) / MILLISECONDS_PER_DAY) + 1;
        if (doc >= 1) daily.set(doc, { dayOfCulture: doc, avgWeightG: Number(sample.avgWeightG) });
    }
    return {
        recordedAt: latest?.recordedAt.toISOString() ?? null, avgWeightG: weight,
        sizePerKg: weight > 0 ? Math.round(1000 / weight) : null,
        dailyWeightGainG: previous && elapsedDays > 0 ? round((weight - Number(previous.avgWeightG)) / elapsedDays, 3) : null,
        beforeLatestHarvest: !afterBoundary(latest),
        series: [...daily.values()],
    };
};

/** Estimates keep independent source times; never combine old weight with a new remaining count. */
const normalizeStock = (season, logs, harvests, latestHarvest) => {
    const final = harvests.find((event) => event.harvest_type === 'final');
    const afterHarvest = (log) => !latestHarvest || log.recordedAt > latestHarvest.harvested_at;
    const populationLog = logs.findLast((log) => log.estimatedPopulation != null && afterHarvest(log));
    const biomassLog = logs.findLast((log) => log.estimatedBiomassKg != null && afterHarvest(log));
    const population = final
        ? { count: 0, recordedAt: final.harvested_at.toISOString(), source: 'HARVEST' }
        : populationLog
            ? { count: toNumber(populationLog.estimatedPopulation), recordedAt: populationLog.recordedAt.toISOString(), source: 'HEALTH_LOG' }
            : latestHarvest?.estimated_remaining_count != null
                ? { count: toNumber(latestHarvest.estimated_remaining_count), recordedAt: latestHarvest.harvested_at.toISOString(), source: 'HARVEST' }
                : null;
    const biomass = final
        ? { kg: 0, recordedAt: final.harvested_at.toISOString() }
        : biomassLog ? { kg: toNumber(biomassLog.estimatedBiomassKg), recordedAt: biomassLog.recordedAt.toISOString() } : null;
    const included = population ? harvests.filter((event) => event.harvested_at <= new Date(population.recordedAt)) : [];
    const enough = population && Number(season.initialQuantity) > 0 && included.every((event) => event.quantity_count != null);
    // Harvested animals survived; missing counts cannot be inferred from rounded commercial size.
    const survivalRatePct = enough ? new Prisma.Decimal(population.count)
        .plus(included.reduce((sum, event) => sum.plus(String(event.quantity_count)), new Prisma.Decimal(0)))
        .div(String(season.initialQuantity)).times(100).toDecimalPlaces(2).toNumber() : null;
    return { population, biomass, survivalRatePct };
};

/** Full daily history for the chart; the card independently uses up to seven Vietnam calendar days. */
const normalizeHealth = (season, logs, now) => {
    const totals = new Map();
    for (const log of logs) {
        const day = localDayStamp(log.recordedAt);
        totals.set(day, (totals.get(day) ?? 0) + Number(log.mortalityCount ?? 0));
    }
    // Missing journal days stay null, including gaps between the first and last real observations.
    const dailyCounts = (from, to) => {
        const entries = [];
        for (let day = from; day <= to; day += MILLISECONDS_PER_DAY) {
            entries.push({ date: dateOnly(new Date(day)), count: totals.get(day) ?? null });
        }
        return entries;
    };
    const ended = season.status !== SEASON_STATUS.ACTIVE;
    const end = ended ? (season.actualEndDate?.getTime() ?? localDayStamp(season.updatedAt)) : localDayStamp(now);
    const start = Math.max(end - 6 * MILLISECONDS_PER_DAY, season.stockingDate?.getTime() ?? -Infinity);
    const daily = dailyCounts(start, end);
    const recordedDays = daily.filter((day) => day.count != null).length;
    const latest = logs.at(-1);
    return {
        recordedAt: latest?.recordedAt.toISOString() ?? null, status: latest?.healthStatus ?? null,
        mortality: { from: dateOnly(new Date(start)), to: dateOnly(new Date(end)), days: daily.length, recordedDays,
            total: recordedDays ? daily.reduce((sum, day) => sum + (day.count ?? 0), 0) : null,
            lastDayCount: daily.at(-1)?.count ?? null,
            series: latest ? dailyCounts(localDayStamp(logs[0].recordedAt), localDayStamp(latest.recordedAt)) : [] },
    };
};

/** Harvest history is professional context, separate from the view's single FCR calculation. */
const normalizeHarvest = (season, harvests) => ({
    count: harvests.length,
    totalWeightKg: harvests.reduce((sum, event) => sum.plus(event.total_weight_kg), new Prisma.Decimal(0)).toNumber(),
    events: harvests.map((event) => ({
        id: event.id, type: event.harvest_type.toUpperCase(), harvestedAt: event.harvested_at.toISOString(),
        dayOfCulture: season.stockingDate ? Math.floor((localDayStamp(event.harvested_at) - season.stockingDate.getTime()) / MILLISECONDS_PER_DAY) + 1 : null,
        quantityCount: toNumber(event.quantity_count), totalWeightKg: toNumber(event.total_weight_kg),
        estimatedRemainingCount: event.harvest_type === 'final' ? 0 : toNumber(event.estimated_remaining_count),
    })),
});

/**
 * Read one coherent snapshot after enforcing the same assignment lifecycle as the list.
 * Owner scope also prevents a stale assignment from exposing another owner's season.
 * Planning seasons deliberately omit operational reads and return null panels.
 */
const getAssignedSeasonMetrics = (accountId, seasonId, now = new Date()) => prisma.$transaction(async (tx) => {
    const account = await tx.account.findFirst({
        where: { id: accountId, role: ACCOUNT_ROLE.EXPERT, status: ACCOUNT_STATUS.ACTIVE },
        select: { managedByOwnerId: true },
    });
    if (!account?.managedByOwnerId) throw ApiError.notFound(messages.EXPERT_SEASON.NOT_FOUND);
    const season = await tx.aquacultureSeason.findFirst({
        where: { id: seasonId, ...assignmentScope(accountId), pond: { farm: { ownerId: account.managedByOwnerId } } },
        select: detailSelect,
    });
    if (!season) throw ApiError.notFound(messages.EXPERT_SEASON.NOT_FOUND);

    const ended = [SEASON_STATUS.COMPLETED, SEASON_STATUS.CANCELLED].includes(season.status);
    const technician = season.personnelAssignments.find((entry) => entry.unassignedAt === null)
        ?? (ended ? season.personnelAssignments[0] : null);
    const result = {
        id: season.id, name: season.name, status: season.status, shrimpType: season.shrimpType,
        dayOfCulture: dayOfCulture(season, now),
        pond: { name: season.pond.name, areaM2: toNumber(season.pond.areaM2), volumeM3: toNumber(season.pond.volumeM3) },
        farm: { name: season.pond.farm.name },
        technician: technician?.account ?? null,
        openCaseCount: season._count.diseaseCases,
        stocking: {
            initialQuantity: toNumber(season.initialQuantity), initialDensityPerM2: toNumber(season.initialDensityPerM2),
            stockingDate: dateOnly(season.stockingDate), expectedEndDate: dateOnly(season.expectedEndDate),
        },
        growth: null,
        stock: null,
        health: null,
        feed: null,
        harvest: null,
        water: null,
    };
    if (season.status === SEASON_STATUS.PLANNING) return result;

    const [logs, water, harvests, operational] = await Promise.all([
        tx.shrimpHealthLog.findMany({
            where: { seasonId, isVoided: false, recordedAt: { lte: now } },
            select: { recordedAt: true, avgWeightG: true, estimatedPopulation: true, estimatedBiomassKg: true, healthStatus: true, mortalityCount: true },
            orderBy: [{ recordedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        }),
        tx.waterQualityLog.findFirst({
            where: { seasonId, isVoided: false, recordedAt: { lte: now } },
            select: { recordedAt: true, ...Object.fromEntries(Object.keys(WATER_THRESHOLDS[season.shrimpType]).map((field) => [field, true])) },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
        readProfessionalHistory(tx, seasonId, now),
        // This view is the sole feed/FCR policy; all reads use the same transaction client.
        tx.seasonOperationalMetrics.findUnique({
            where: { seasonId },
            select: { asOf: true, totalFeedKg: true, estimatedFcr: true },
        }),
    ]);

    const latestHarvest = harvests.find((event) => event.harvest_type === 'final') ?? harvests.at(-1);
    result.growth = normalizeGrowth(season, logs, latestHarvest);
    result.stock = normalizeStock(season, logs, harvests, latestHarvest);
    result.health = normalizeHealth(season, logs, now);
    result.harvest = normalizeHarvest(season, harvests);
    result.feed = {
        asOf: operational?.asOf?.toISOString() ?? null,
        totalFeedKg: toNumber(operational?.totalFeedKg), estimatedFcr: toNumber(operational?.estimatedFcr),
        awaitingPostHarvestBiomass: latestHarvest?.harvest_type === 'partial' && !result.stock.biomass,
    };
    if (water) result.water = {
        recordedAt: water.recordedAt.toISOString(),
        metrics: Object.entries(WATER_THRESHOLDS[season.shrimpType]).map(([field, { min, max }]) => {
            const value = toNumber(water[field]);
            return { field, value, min, max,
                exceeded: value != null && ((min != null && value < min) || (max != null && value > max)) };
        }),
    };
    return result;
}, { isolationLevel: 'RepeatableRead' });

module.exports = { getAssignedSeasons, getAssignedSeasonMetrics };
