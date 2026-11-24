const { Prisma } = require('@prisma/client');
const { availableAt, recalculateHealthPopulations } = require('./seasonPopulation.service');
const prisma = require('../config/prisma');
const { assertCalculationStorage } = require('../utils/jobStorage');
const { ApiError } = require('../utils');
const {
    messages,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    HEALTH_STATUS,
    OPERATION_STATUS,
    WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS,
} = require('../constants');

/**
 * Manage immutable shrimp health observations, void lifecycle and growth projections.
 * Only the currently assigned Technician of an ACTIVE season may record or void observations.
 * Non-voided observations provide the authoritative biomass basis for rolling operational schedules.
 */

const RECORDED_AT_FUTURE_TOLERANCE_MS = (WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS || 300) * 1000;
const STATISTICS_MAX_RANGE_DAYS = 90;
const FARM_TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Saigon UTC+7

const SEASON_WITH_FARM_SELECT = {
    id: true,
    name: true,
    status: true,
    shrimpType: true,
    stockingDate: true,
    initialQuantity: true,
    pond: {
        select: {
            id: true,
            name: true,
            farm: {
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                },
            },
        },
    },
};

// Scope resolvers ------------------------------------------------------------

/**
 * Load season and farm context for health log permission checks.
 */
const findSeason = (seasonId) =>
    prisma.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: SEASON_WITH_FARM_SELECT,
    });

/**
 * Check that the account still holds the required season role.
 */
const hasActiveAssignment = (accountId, seasonId, role) =>
    prisma.seasonPersonnelAssignment.findFirst({
        where: { seasonId, accountId, role, unassignedAt: null },
        select: { id: true },
    });

/**
 * Require a current technician assignment and an active season when requested.
 */
const resolveKtvScope = async (accountId, seasonId, { requireActiveSeason = false } = {}) => {
    const season = await findSeason(seasonId);
    if (!season) {
        throw ApiError.notFound(messages.SHRIMP_HEALTH_LOG.NOT_FOUND);
    }
    const assignment = await hasActiveAssignment(accountId, seasonId, PERSONNEL_ROLE.TECHNICIAN);
    if (!assignment) {
        throw ApiError.forbidden(messages.SHRIMP_HEALTH_LOG.NO_ASSIGNMENT);
    }
    if (requireActiveSeason && season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.SEASON_NOT_ACTIVE);
    }
    return season;
};

/**
 * Require a current expert assignment to read the season's health logs.
 */
const resolveExpertScope = async (accountId, seasonId) => {
    const season = await findSeason(seasonId);
    if (!season) {
        throw ApiError.notFound(messages.SHRIMP_HEALTH_LOG.NOT_FOUND);
    }
    const assignment = await hasActiveAssignment(accountId, seasonId, PERSONNEL_ROLE.EXPERT);
    if (!assignment) {
        throw ApiError.forbidden(messages.SHRIMP_HEALTH_LOG.NO_ASSIGNMENT);
    }
    return season;
};

/**
 * Allow owner access only when the season belongs to the account's farm.
 */
const resolveOwnerScope = async (accountId, seasonId) => {
    const season = await findSeason(seasonId);
    if (!season || season.pond.farm.ownerId !== accountId) {
        throw ApiError.forbidden(messages.SHRIMP_HEALTH_LOG.NO_ASSIGNMENT);
    }
    return season;
};

const SCOPE_RESOLVERS = {
    ktv: resolveKtvScope,
    expert: resolveExpertScope,
    owner: resolveOwnerScope,
};

// Normalization and formatting helpers ----------------------------------------

/**
 * Keep missing health measurements distinct from numeric zero in API responses.
 */
const toNumberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Keep absent health log timestamps as null in API responses.
 */
const toIsoOrNull = (value) => (value === null || value === undefined ? null : value.toISOString());

/**
 * Use the stocking date as day one for an observation and require both dates to calculate it.
 */
const calculateDoc = (stockingDate, recordedAt) => {
    if (!stockingDate || !recordedAt) return null;
    const stock = new Date(stockingDate);
    const rec = new Date(recordedAt);
    const diffTime = rec.getTime() - stock.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(1, diffDays + 1);
};

/**
 * Expose observation and voiding details with account names resolved by the caller.
 */
const normalizeLog = (log, stockingDate, accountMap = {}) => {
    const recorder = accountMap[log.recordedBy] || null;
    const voider = log.voidedBy ? accountMap[log.voidedBy] || null : null;

    return {
        id: log.id,
        seasonId: log.seasonId,
        recordedBy: log.recordedBy,
        recordedByName: recorder?.fullName || null,
        recordedByEmail: recorder?.email || null,
        recordedAt: log.recordedAt.toISOString(),
        dayOfCulture: calculateDoc(stockingDate, log.recordedAt),
        sampleSize:
            log.sampleSize !== null && log.sampleSize !== undefined ? Number(log.sampleSize) : null,
        avgWeightG: toNumberOrNull(log.avgWeightG),
        avgLengthCm: toNumberOrNull(log.avgLengthCm),
        mortalityCount:
            log.mortalityCount !== null && log.mortalityCount !== undefined
                ? Number(log.mortalityCount)
                : 0,
        estimatedPopulation:
            log.estimatedPopulation !== null && log.estimatedPopulation !== undefined
                ? Number(log.estimatedPopulation)
                : null,
        estimatedBiomassKg: toNumberOrNull(log.estimatedBiomassKg),
        healthStatus: log.healthStatus,
        note: log.note || null,
        isVoided: Boolean(log.isVoided),
        voidedBy: log.voidedBy || null,
        voidedByName: voider?.fullName || null,
        voidedByEmail: voider?.email || null,
        voidedAt: toIsoOrNull(log.voidedAt),
        voidReason: log.voidReason || null,
        createdAt: log.createdAt.toISOString(),
    };
};

/**
 * Load recorder and voider account details together for a page of observations.
 */
const fetchAccountMap = async (accountIds) => {
    const validIds = [...new Set(accountIds.filter(Boolean))];
    if (validIds.length === 0) return {};

    const accounts = await prisma.account.findMany({
        where: { id: { in: validIds } },
        select: { id: true, fullName: true, email: true },
    });

    const map = {};
    for (const acc of accounts) {
        map[acc.id] = acc;
    }
    return map;
};

// Cursor condition ----------------------------------------------------------

/**
 * Preserve the recorded time and log ID used to order the next page.
 */
const encodeCursor = ({ recordedAt, id }) =>
    Buffer.from(JSON.stringify({ recordedAt: recordedAt.toISOString(), logId: id })).toString(
        'base64url',
    );

/**
 * Reject malformed cursors before using their timestamp and UUID in a query.
 */
const decodeCursor = (cursor) => {
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const recordedAt = new Date(value.recordedAt);
        const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidV4.test(value.logId) || Number.isNaN(recordedAt.getTime())) {
            throw new Error();
        }
        return { recordedAt, logId: value.logId };
    } catch (_) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.INVALID_CURSOR);
    }
};

// In-memory idempotency store ------------------------------------------------

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotencyStore = new Map();

/**
 * Discard expired process-local retry entries before checking a request.
 */
const idempotencyGet = (key) => {
    if (!key) return null;
    const entry = idempotencyStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        idempotencyStore.delete(key);
        return null;
    }
    return entry;
};

/**
 * Retain the in-flight or completed submission state for the retry window.
 */
const idempotencySet = (key, value) => {
    if (!key) return;
    idempotencyStore.set(key, { ...value, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
};

/**
 * Record an authorized observation and recalculate dependent population estimates in one transaction.
 */
const createShrimpHealthLog = async (accountId, seasonId, data, idempotencyKey = '') => {
    const season = await resolveKtvScope(accountId, seasonId, { requireActiveSeason: true });

    const recordedAt = new Date(data.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.INVALID_RECORDED_AT);
    }
    if (recordedAt.getTime() > Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.RECORDED_AT_TOO_FAR_FUTURE);
    }
    // Observations cannot be backdated to previous calendar days in the farm timezone (UTC+7).
    const nowFarm = new Date(Date.now() + FARM_TZ_OFFSET_MS);
    const startOfTodayFarm = new Date(
        Date.UTC(nowFarm.getUTCFullYear(), nowFarm.getUTCMonth(), nowFarm.getUTCDate()) -
            FARM_TZ_OFFSET_MS,
    );

    if (recordedAt.getTime() < startOfTodayFarm.getTime()) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.RECORDED_AT_PAST_DAY);
    }

    let sampleSize =
        data.sampleSize !== undefined && data.sampleSize !== null ? Number(data.sampleSize) : null;
    let avgWeightG =
        data.avgWeightG !== undefined && data.avgWeightG !== null ? Number(data.avgWeightG) : null;
    let avgLengthCm =
        data.avgLengthCm !== undefined && data.avgLengthCm !== null
            ? Number(data.avgLengthCm)
            : null;
    let mortalityCount =
        data.mortalityCount !== undefined && data.mortalityCount !== null
            ? Number(data.mortalityCount)
            : 0;

    if (mortalityCount < 0) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.MORTALITY_INVALID);
    }

    const liveAvailable = await availableAt(prisma, season, recordedAt);
    if (liveAvailable !== null && BigInt(mortalityCount) > BigInt(liveAvailable)) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.MORTALITY_EXCEEDS_AVAILABLE);
    }
    let estimatedPopulation =
        data.estimatedPopulation !== undefined && data.estimatedPopulation !== null
            ? Number(data.estimatedPopulation)
            : null;

    if (
        estimatedPopulation !== null &&
        season.initialQuantity &&
        BigInt(estimatedPopulation) > BigInt(season.initialQuantity)
    ) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.ESTIMATED_POPULATION_EXCEEDS_INITIAL);
    }

    let estimatedBiomassKg =
        data.estimatedBiomassKg !== undefined && data.estimatedBiomassKg !== null
            ? Number(data.estimatedBiomassKg)
            : null;
    const healthStatus = data.healthStatus || HEALTH_STATUS.GOOD;
    const note = (data.note || '').trim() || null;

    // If mean body weight is omitted (e.g. mortality-only log), inherit latest valid weight & length prior to recordedAt
    if (avgWeightG === null || avgWeightG <= 0) {
        const previousObservation = await prisma.shrimpHealthLog.findFirst({
            where: {
                seasonId,
                isVoided: false,
                avgWeightG: { not: null, gt: 0 },
                recordedAt: { lte: recordedAt },
            },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        });
        if (previousObservation) {
            avgWeightG = Number(previousObservation.avgWeightG);
            if ((avgLengthCm === null || avgLengthCm <= 0) && previousObservation.avgLengthCm) {
                avgLengthCm = Number(previousObservation.avgLengthCm);
            }
        }
    }

    // Infer biomass from population and mean body weight when an explicit weight is omitted.
    if (
        estimatedBiomassKg === null &&
        estimatedPopulation !== null &&
        avgWeightG !== null &&
        estimatedPopulation > 0 &&
        avgWeightG > 0
    ) {
        estimatedBiomassKg = Math.round(((estimatedPopulation * avgWeightG) / 1000) * 1000) / 1000;
    }

    // Reject concurrent submissions sharing the same in-flight idempotency key.
    const rawKey = (idempotencyKey || '').trim().slice(0, 128);
    const key = rawKey ? JSON.stringify([accountId, seasonId, rawKey]) : '';
    const fingerprint = JSON.stringify([
        recordedAt.toISOString(),
        sampleSize,
        avgWeightG,
        avgLengthCm,
        mortalityCount,
        estimatedPopulation,
        estimatedBiomassKg,
        healthStatus,
        note,
    ]);

    const prior = idempotencyGet(key);
    if (prior && prior.fingerprint !== fingerprint) {
        throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.IDEMPOTENCY_KEY_REUSED);
    }
    if (prior?.status === 'done' && prior.logId) {
        const existing = await prisma.shrimpHealthLog.findUnique({
            where: { id: prior.logId },
        });
        if (existing && existing.seasonId === seasonId && existing.recordedBy === accountId) {
            const accountMap = await fetchAccountMap([existing.recordedBy]);
            return {
                log: normalizeLog(existing, season.stockingDate, accountMap),
                duplicate: true,
            };
        }
    }
    if (prior?.status === 'processing') {
        throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.DUPLICATE_LOG);
    }
    idempotencySet(key, { status: 'processing', fingerprint });

    try {
        const created = await prisma.$transaction(
            async (tx) => {
                await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${seasonId}::uuid FOR UPDATE`;
                const current = await tx.aquacultureSeason.findFirst({
                    where: {
                        id: seasonId,
                        status: SEASON_STATUS.ACTIVE,
                        personnelAssignments: {
                            some: {
                                accountId,
                                role: PERSONNEL_ROLE.TECHNICIAN,
                                unassignedAt: null,
                            },
                        },
                    },
                    select: { id: true },
                });
                if (!current) throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.NO_ASSIGNMENT);
                const log = await tx.shrimpHealthLog.create({
                    data: {
                        seasonId,
                        recordedBy: accountId,
                        recordedAt,
                        sampleSize,
                        avgWeightG: avgWeightG !== null ? avgWeightG : undefined,
                        avgLengthCm: avgLengthCm !== null ? avgLengthCm : undefined,
                        mortalityCount: BigInt(mortalityCount),
                        estimatedPopulation:
                            estimatedPopulation !== null ? BigInt(estimatedPopulation) : undefined,
                        estimatedBiomassKg:
                            estimatedBiomassKg !== null ? estimatedBiomassKg : undefined,
                        healthStatus,
                        note,
                    },
                });

                await recalculateHealthPopulations(tx, season);

                const fresh = await tx.shrimpHealthLog.findUnique({ where: { id: log.id } });
                return fresh || log;
            },
            { isolationLevel: 'Serializable' },
        );

        require('../jobs').requestSeason(seasonId);
        idempotencySet(key, { status: 'done', fingerprint, logId: created.id });

        const accountMap = await fetchAccountMap([created.recordedBy]);
        return { log: normalizeLog(created, season.stockingDate, accountMap), duplicate: false };
    } catch (error) {
        idempotencyStore.delete(key);
        if (error.code === 'P2034') {
            throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.RECORDING_CONFLICT);
        }
        throw error;
    }
};

/**
 * Apply role-specific season access before reading a filtered cursor page of observations.
 */
const listShrimpHealthLogs = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const where = { seasonId };

    // Date range boundaries
    if (query.from || query.to) {
        where.recordedAt = {};
        if (query.from) where.recordedAt.gte = new Date(query.from);
        if (query.to) where.recordedAt.lte = new Date(query.to);
    }

    // Health status filter
    if (query.healthStatus) {
        where.healthStatus = query.healthStatus;
    }

    // Validity filter
    const filter = query.filter || (query.includeVoided ? 'all' : 'valid');
    if (filter === 'valid') {
        where.isVoided = false;
    } else if (filter === 'voided') {
        where.isVoided = true;
    }

    // Cursor pagination
    let cursorClause = {};
    if (query.cursor) {
        const { recordedAt, logId } = decodeCursor(query.cursor);
        cursorClause = {
            OR: [
                { recordedAt: { lt: recordedAt } },
                { AND: [{ recordedAt }, { id: { lt: logId } }] },
            ],
        };
    }

    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);

    const finalWhere = cursorClause.OR ? { AND: [where, cursorClause] } : where;

    const rows = await prisma.shrimpHealthLog.findMany({
        where: finalWhere,
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
    });

    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;

    // Resolve actor profile snapshots for distinct author IDs
    const accountIds = [];
    for (const r of pageRows) {
        accountIds.push(r.recordedBy);
        if (r.voidedBy) accountIds.push(r.voidedBy);
    }
    const accountMap = await fetchAccountMap(accountIds);

    const logs = pageRows.map((r) => normalizeLog(r, season.stockingDate, accountMap));

    let nextCursor = null;
    if (hasNext && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        nextCursor = encodeCursor({ recordedAt: last.recordedAt, id: last.id });
    }

    let counts = null;
    if (query.includeCounts) {
        const [total, valid, voided, warningOrCritical] = await Promise.all([
            prisma.shrimpHealthLog.count({ where: { seasonId } }),
            prisma.shrimpHealthLog.count({ where: { seasonId, isVoided: false } }),
            prisma.shrimpHealthLog.count({ where: { seasonId, isVoided: true } }),
            prisma.shrimpHealthLog.count({
                where: {
                    seasonId,
                    isVoided: false,
                    healthStatus: { in: [HEALTH_STATUS.WARNING, HEALTH_STATUS.CRITICAL] },
                },
            }),
        ]);
        counts = { total, valid, voided, warningOrCritical };
    }

    return {
        logs,
        nextCursor,
        hasNext,
        ...(counts ? { counts } : {}),
    };
};

/**
 * Read and enrich the observation only within the authorized season.
 */
const getShrimpHealthLogDetail = async (accountId, seasonId, logId, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const log = await prisma.shrimpHealthLog.findFirst({
        where: { id: logId, seasonId },
    });
    if (!log) {
        throw ApiError.notFound(messages.SHRIMP_HEALTH_LOG.NOT_FOUND);
    }

    const accountMap = await fetchAccountMap([log.recordedBy, log.voidedBy]);
    return normalizeLog(log, season.stockingDate, accountMap);
};

/**
 * Void the observation, cancel unexecuted schedules that used it, and recalculate remaining estimates
 * atomically.
 */
const voidShrimpHealthLog = async (accountId, seasonId, logId, { voidReason }) => {
    if (!voidReason || !voidReason.trim()) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.VOID_REASON_REQUIRED);
    }

    const season = await resolveKtvScope(accountId, seasonId);

    const updated = await prisma.$transaction(async (tx) => {
        // Shared order with generation/execution: season first, then dependent schedules.
        await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
        const currentSeason = await tx.aquacultureSeason.findFirst({
            where: {
                id: seasonId,
                personnelAssignments: {
                    some: { accountId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null },
                },
            },
            select: { status: true },
        });
        if (currentSeason?.status !== SEASON_STATUS.ACTIVE) {
            throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.VOID_FORBIDDEN_STATE);
        }
        const log = await tx.shrimpHealthLog.findFirst({ where: { id: logId, seasonId } });
        if (!log) throw ApiError.notFound(messages.SHRIMP_HEALTH_LOG.NOT_FOUND);
        if (log.isVoided) throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.ALREADY_VOIDED);
        const voidedAt = new Date();
        await assertCalculationStorage(tx);
        const changed = await tx.shrimpHealthLog.updateMany({
            where: { id: logId, seasonId, isVoided: false },
            data: {
                isVoided: true,
                voidedBy: accountId,
                voidedAt,
                voidReason: voidReason.trim(),
            },
        });
        if (changed.count !== 1) {
            throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.ALREADY_VOIDED);
        }
        // Cancel only pending facts. Completed executions and their inventory history stay immutable.
        await tx.operationSchedule.updateMany({
            where: {
                seasonId,
                sourceHealthLogId: logId,
                status: OPERATION_STATUS.PLANNED,
                execution: null,
            },
            data: {
                status: OPERATION_STATUS.CANCELLED,
                cancelledAt: voidedAt,
                cancelledBy: accountId,
                cancellationType: 'CALCULATION_CHANGED',
                cancellationReason: messages.PRODUCTION_PROTOCOL.BIOMASS_SOURCE_VOIDED,
            },
        });

        // Recalculate estimatedPopulation and estimatedBiomassKg for remaining active logs
        await recalculateHealthPopulations(tx, season);

        return {
            ...log,
            isVoided: true,
            voidedBy: accountId,
            voidedAt,
            voidReason: voidReason.trim(),
        };
    });

    require('../jobs').requestSeason(seasonId);
    const accountMap = await fetchAccountMap([updated.recordedBy, updated.voidedBy]);
    return normalizeLog(updated, season.stockingDate, accountMap);
};

/**
 * Label observations by Vietnam calendar day or by the Monday that starts their week.
 */
const bucketKeyOf = (date, granularity) => {
    const shifted = new Date(date.getTime() + FARM_TZ_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = shifted.getUTCDate();
    if (granularity === 'week') {
        const dow = (shifted.getUTCDay() + 6) % 7; // Monday = 0
        const monday = new Date(Date.UTC(y, shifted.getUTCMonth(), d - dow));
        return monday.toISOString().slice(0, 10);
    }
    return `${y}-${m}-${String(d).padStart(2, '0')}`;
};

/**
 * Build the growth series and distribution from valid observations and derive current survival from
 * the latest valid sample.
 */
const getStatistics = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const from = new Date(query.from);
    const to = new Date(query.to);
    const granularity = query.granularity || 'day';
    const rangeDays = (to.getTime() - from.getTime()) / 86400000;
    if (!Number.isFinite(rangeDays) || rangeDays < 0 || rangeDays > STATISTICS_MAX_RANGE_DAYS) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.INVALID_DATE_RANGE);
    }

    // Voided observations are strictly excluded from growth curves and statistical summaries.
    const rows = await prisma.shrimpHealthLog.findMany({
        where: {
            seasonId,
            isVoided: false,
            recordedAt: { gte: from, lte: to },
        },
        orderBy: { recordedAt: 'asc' },
    });

    const statusCounts = {
        EXCELLENT: 0,
        GOOD: 0,
        WARNING: 0,
        CRITICAL: 0,
    };

    let totalMortality = 0;
    const growthSeries = [];

    for (const r of rows) {
        if (statusCounts[r.healthStatus] !== undefined) {
            statusCounts[r.healthStatus] += 1;
        }

        const mort =
            r.mortalityCount !== null && r.mortalityCount !== undefined
                ? Number(r.mortalityCount)
                : 0;
        totalMortality += mort;

        const dateKey = bucketKeyOf(r.recordedAt, granularity);
        const doc = calculateDoc(season.stockingDate, r.recordedAt);

        // Map valid observation to discrete growth time series point
        growthSeries.push({
            date: dateKey,
            recordedAt: r.recordedAt.toISOString(),
            dayOfCulture: doc,
            avgWeightG: toNumberOrNull(r.avgWeightG),
            avgLengthCm: toNumberOrNull(r.avgLengthCm),
            estimatedBiomassKg: toNumberOrNull(r.estimatedBiomassKg),
            estimatedPopulation:
                r.estimatedPopulation !== null && r.estimatedPopulation !== undefined
                    ? Number(r.estimatedPopulation)
                    : null,
            mortalityCount: mort,
            healthStatus: r.healthStatus,
        });
    }

    // Resolve latest valid observations for summary metrics card:
    // Take the latest valid non-voided measurement for each indicator.
    const [
        latestValidLog,
        latestBiomassLog,
        latestAvgWeightLog,
        latestAvgLengthLog,
        latestPopulationLog,
    ] = await Promise.all([
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId, isVoided: false },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId, isVoided: false, estimatedBiomassKg: { not: null, gt: 0 } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId, isVoided: false, avgWeightG: { not: null, gt: 0 } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId, isVoided: false, avgLengthCm: { not: null, gt: 0 } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId, isVoided: false, estimatedPopulation: { not: null } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        }),
    ]);

    const initialQty =
        season.initialQuantity !== null && season.initialQuantity !== undefined
            ? Number(season.initialQuantity)
            : null;

    // Use availableAt to accurately account for partial/final harvests and post-harvest mortalities
    const liveAvailable = await availableAt(prisma, season, to);
    const currentPop =
        liveAvailable !== null
            ? Number(liveAvailable)
            : (latestPopulationLog?.estimatedPopulation !== null &&
               latestPopulationLog?.estimatedPopulation !== undefined
                ? Number(latestPopulationLog.estimatedPopulation)
                : (latestValidLog?.estimatedPopulation !== null &&
                   latestValidLog?.estimatedPopulation !== undefined
                    ? Number(latestValidLog.estimatedPopulation)
                    : null));

    // Harvested animals survived; query total harvested to calculate accurate survival rate
    const [harvestAgg] = await prisma.$queryRaw(Prisma.sql`
        SELECT coalesce(sum(quantity_count), 0)::bigint AS total_harvested
        FROM harvest_events
        WHERE season_id = ${seasonId}::uuid AND harvested_at <= ${to}
    `);
    const totalHarvestedCount = harvestAgg?.total_harvested != null
        ? Number(harvestAgg.total_harvested)
        : 0;

    let survivalRatePercent = null;
    if (initialQty && initialQty > 0 && currentPop !== null) {
        const totalLivingOrHarvested = currentPop + totalHarvestedCount;
        survivalRatePercent = Math.min(
            100,
            Math.max(0, Math.round((totalLivingOrHarvested / initialQty) * 10000) / 100),
        );
    }

    // Resolve current biomass; adjust if partial harvest occurred after the latest biomass measurement
    const [latestHarvest] = await prisma.$queryRaw(Prisma.sql`
        SELECT id, harvest_type, harvested_at
        FROM harvest_events
        WHERE season_id = ${seasonId}::uuid AND harvested_at <= ${to}
        ORDER BY harvested_at DESC, id DESC LIMIT 1
    `);
    let currentBiomassKg = toNumberOrNull(latestBiomassLog?.estimatedBiomassKg);
    if (latestHarvest) {
        if (latestHarvest.harvest_type === 'final') {
            currentBiomassKg = 0;
        } else if (
            latestBiomassLog &&
            new Date(latestHarvest.harvested_at) > new Date(latestBiomassLog.recordedAt) &&
            latestAvgWeightLog?.avgWeightG &&
            currentPop != null &&
            currentPop > 0
        ) {
            currentBiomassKg = Math.round(((currentPop * Number(latestAvgWeightLog.avgWeightG)) / 1000) * 10) / 10;
        }
    }

    const totalValidLogs = rows.length;
    const healthDistribution = {
        totalLogs: totalValidLogs,
        excellent: {
            count: statusCounts.EXCELLENT,
            percent:
                totalValidLogs > 0
                    ? Math.round((statusCounts.EXCELLENT / totalValidLogs) * 1000) / 10
                    : 0,
        },
        good: {
            count: statusCounts.GOOD,
            percent:
                totalValidLogs > 0
                    ? Math.round((statusCounts.GOOD / totalValidLogs) * 1000) / 10
                    : 0,
        },
        warning: {
            count: statusCounts.WARNING,
            percent:
                totalValidLogs > 0
                    ? Math.round((statusCounts.WARNING / totalValidLogs) * 1000) / 10
                    : 0,
        },
        critical: {
            count: statusCounts.CRITICAL,
            percent:
                totalValidLogs > 0
                    ? Math.round((statusCounts.CRITICAL / totalValidLogs) * 1000) / 10
                    : 0,
        },
    };

    return {
        seasonId,
        shrimpType: season.shrimpType,
        stockingDate: season.stockingDate ? season.stockingDate.toISOString().slice(0, 10) : null,
        initialQuantity: initialQty,
        summary: {
            currentBiomassKg,
            currentAvgWeightG: toNumberOrNull(latestAvgWeightLog?.avgWeightG),
            currentAvgLengthCm: toNumberOrNull(latestAvgLengthLog?.avgLengthCm),
            currentPopulation: currentPop,
            currentHealthStatus: latestValidLog?.healthStatus || null,
            survivalRatePercent,
            totalMortalityInRange: totalMortality,
            totalLogsInRange: totalValidLogs,
            lastRecordedAt: toIsoOrNull(latestValidLog?.recordedAt),
        },
        healthDistribution,
        growthSeries,
    };
};

/** Return a population preview only to the assigned Technician of an active season. */
const getPopulation = async (accountId, seasonId, at = new Date()) => {
    const season = await resolveKtvScope(accountId, seasonId, { requireActiveSeason: true });
    const available = await availableAt(prisma, season, new Date(at));
    return { availableQuantityCount: available == null ? null : available.toString(),
        at: new Date(at).toISOString() };
};

module.exports = {
    getPopulation,
    createShrimpHealthLog,
    listShrimpHealthLogs,
    getShrimpHealthLogDetail,
    voidShrimpHealthLog,
    getStatistics,
};
