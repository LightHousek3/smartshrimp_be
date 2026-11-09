const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    messages,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    NOTIFICATION_TYPE,
    checkWaterThresholds,
    WATER_THRESHOLDS,
    THRESHOLD_FIELD_MAP,
    WATER_METRIC_DEFINITIONS,
    WATER_METRICS_POLICY_VERSION,
    WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS,
    WATER_NOTE_MAX_LENGTH,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

/**
 * Manage water quality observations, threshold exceedance alerts and void lifecycles.
 * Measurements are recorded by assigned technicians and evaluated against species-specific warning limits.
 * Threshold alert notifications commit within the measurement transaction and dispatch after commit.
 */

const RECORDED_AT_FUTURE_TOLERANCE_MS = WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS * 1000;
const FARM_TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Saigon, không DST

const METRIC_FIELDS = [
    'temperatureC',
    'ph',
    'dissolvedOxygenMgL',
    'salinityPpt',
    'nh3MgL',
    'no2MgL',
    'alkalinityMgLCaCO3',
    'h2sMgL',
];

const PARAM_LABELS = {
    temperatureC: 'Nhiệt độ',
    ph: 'pH',
    dissolvedOxygenMgL: 'DO',
    salinityPpt: 'Độ mặn',
    nh3MgL: 'NH3',
    no2MgL: 'NO2',
    alkalinityMgLCaCO3: 'Kiềm',
    h2sMgL: 'H2S',
};

const PARAM_UNITS = {
    temperatureC: '°C',
    ph: '',
    dissolvedOxygenMgL: 'mg/L',
    salinityPpt: '‰',
    nh3MgL: 'mg/L',
    no2MgL: 'mg/L',
    alkalinityMgLCaCO3: 'mg/L',
    h2sMgL: 'mg/L',
};

const SEASON_WITH_FARM_SELECT = {
    id: true,
    name: true,
    status: true,
    shrimpType: true,
    stockingDate: true,
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

// Scope resolution -----------------------------------------------------------

const findSeason = (seasonId, client = prisma) =>
    client.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: SEASON_WITH_FARM_SELECT,
    });

const hasActiveAssignment = (accountId, seasonId, role, client = prisma) =>
    client.seasonPersonnelAssignment.findFirst({
        where: { seasonId, accountId, role, unassignedAt: null },
        select: { id: true },
    });

/** Resolve technician assignment and ensure the season is ACTIVE for mutation paths. */
const resolveKtvScope = async (accountId, seasonId, { requireActiveSeason = false, client = prisma } = {}) => {
    const season = await findSeason(seasonId, client);
    if (!season) {
        throw ApiError.notFound(messages.WATER_LOG.NOT_FOUND);
    }
    const assignment = await hasActiveAssignment(accountId, seasonId, PERSONNEL_ROLE.TECHNICIAN, client);
    if (!assignment) {
        throw ApiError.forbidden(messages.WATER_LOG.NO_ASSIGNMENT);
    }
    if (requireActiveSeason && season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.conflict(messages.WATER_LOG.SEASON_NOT_ACTIVE);
    }
    return season;
};

/** Resolve active expert assignment scope for read-only access. */
const resolveExpertScope = async (accountId, seasonId) => {
    const season = await findSeason(seasonId);
    if (!season) {
        throw ApiError.notFound(messages.WATER_LOG.NOT_FOUND);
    }
    const assignment = await hasActiveAssignment(accountId, seasonId, PERSONNEL_ROLE.EXPERT);
    if (!assignment) {
        throw ApiError.forbidden(messages.WATER_LOG.NO_ASSIGNMENT);
    }
    return season;
};

/** Resolve farm ownership scope for read-only access. */
const resolveOwnerScope = async (accountId, seasonId) => {
    const season = await findSeason(seasonId);
    if (
        !season ||
        season.pond.farm.ownerId !== accountId
    ) {
        throw ApiError.forbidden(messages.WATER_LOG.NO_ASSIGNMENT);
    }
    return season;
};

const SCOPE_RESOLVERS = {
    ktv: resolveKtvScope,
    expert: resolveExpertScope,
    owner: resolveOwnerScope,
};

const getMetadata = async (accountId, seasonId, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    const season = await resolver(accountId, seasonId);
    const thresholds = WATER_THRESHOLDS[season.shrimpType];
    if (!thresholds) throw new Error(`Unknown shrimp type: ${season.shrimpType}`);
    return {
        schemaVersion: 1,
        policyVersion: WATER_METRICS_POLICY_VERSION,
        shrimpType: season.shrimpType,
        recordedAtFutureToleranceSeconds: WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS,
        noteMaxLength: WATER_NOTE_MAX_LENGTH,
        metrics: Object.entries(WATER_METRIC_DEFINITIONS).map(([field, definition]) => ({
            field,
            ...definition,
            unit: thresholds[field].unit,
            warningMin: thresholds[field].min,
            warningMax: thresholds[field].max,
        })),
    };
};

// Output normalization -------------------------------------------------------

const toNumberOrNull = (value) =>
    value === null || value === undefined ? null : Number(value);

const toIsoOrNull = (value) =>
    value === null || value === undefined ? null : value.toISOString();

const normalizeLog = (log, shrimpType) => {
    const values = {};
    for (const field of METRIC_FIELDS) {
        values[field] = toNumberOrNull(log[field]);
    }
    const exceededParameterDetails = checkWaterThresholds(shrimpType, values);
    return {
        id: log.id,
        seasonId: log.seasonId,
        recordedBy: log.recordedBy,
        recordedAt: log.recordedAt.toISOString(),
        ...values,
        note: log.note,
        isVoided: log.isVoided,
        voidedBy: log.voidedBy,
        voidedAt: toIsoOrNull(log.voidedAt),
        voidReason: log.voidReason,
        createdAt: log.createdAt.toISOString(),
        exceededParameters: exceededParameterDetails.map((e) => e.field),
        exceededParameterDetails,
    };
};

// Cursor pagination ----------------------------------------------------------

const encodeCursor = ({ recordedAt, id }) =>
    Buffer.from(
        JSON.stringify({ recordedAt: recordedAt.toISOString(), logId: id }),
    ).toString('base64url');

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
        throw ApiError.badRequest(messages.WATER_LOG.INVALID_CURSOR);
    }
};

// In-memory idempotency store with database unique constraint as the final guard --

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotencyStore = new Map();

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

const idempotencySet = (key, entry) => {
    if (!key) return;
    if (idempotencyStore.size > 10000) {
        const now = Date.now();
        for (const [k, v] of idempotencyStore) {
            if (v.expiresAt <= now) idempotencyStore.delete(k);
        }
    }
    idempotencyStore.set(key, { ...entry, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
};



const buildThresholdAlertContent = (season, exceeded) => {
    const parts = exceeded.map((e) => {
        const unit = PARAM_UNITS[e.field];
        return `${PARAM_LABELS[e.field]}=${e.value}${unit ? ` ${unit}` : ''}`;
    });
    return (
        `Ao ${season.pond.name} (${season.name}): ` +
        `${parts.join(', ')} vượt ngưỡng.`
    );
};

/**
 * Create a water quality log for a technician currently assigned to an active season.
 * Reject measurements too far in the future and reuse matching idempotent requests.
 * Save threshold alerts with the log in one transaction, then emit the notification
 * after commit. Idempotency keys are cached only within this server instance.
 */
const createWaterLog = async (accountId, seasonId, payload, idempotencyKey) => {
    const season = await resolveKtvScope(accountId, seasonId, { requireActiveSeason: true });

    const recordedAt = new Date(payload.recordedAt);
    if (recordedAt.getTime() > Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS) {
        throw ApiError.badRequest(messages.WATER_LOG.RECORDED_AT_TOO_FAR_FUTURE);
    }

    const metricData = {};
    for (const field of METRIC_FIELDS) {
        const value = payload[field];
        metricData[field] = value === null || value === undefined || value === ''
            ? null
            : Number(value);
    }
    const note = payload.note?.trim() || null;
    const rawKey = (idempotencyKey || '').trim().slice(0, 128);
    const key = rawKey ? JSON.stringify([accountId, seasonId, rawKey]) : '';
    const fingerprint = JSON.stringify([recordedAt.toISOString(), metricData, note]);
    const prior = idempotencyGet(key);
    if (prior && prior.fingerprint !== fingerprint) {
        throw ApiError.conflict(messages.WATER_LOG.IDEMPOTENCY_KEY_REUSED);
    }
    if (prior?.status === 'done' && prior.logId) {
        const existing = await prisma.waterQualityLog.findUnique({
            where: { id: prior.logId },
        });
        if (existing && existing.seasonId === seasonId && existing.recordedBy === accountId) {
            return { log: normalizeLog(existing, season.shrimpType), duplicate: true };
        }
    }
    if (prior?.status === 'processing') {
        throw ApiError.conflict(messages.WATER_LOG.DUPLICATE_LOG);
    }
    idempotencySet(key, { status: 'processing', fingerprint });

    try {
        const { log, exceeded, notifications } = await prisma.$transaction(async (tx) => {
            // Final harvest holds this same aggregate lock until completion commits.
            // Re-read state and assignment after waiting; the earlier scope is only a fast rejection.
            await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
            const season = await resolveKtvScope(accountId, seasonId, { requireActiveSeason: true, client: tx });
            const created = await tx.waterQualityLog.create({
                data: {
                    seasonId,
                    recordedBy: accountId,
                    recordedAt,
                    ...metricData,
                    note,
                },
            });

            // Use persisted NUMERIC values so the alert agrees with the response/statistics.
            const exceededParams = checkWaterThresholds(season.shrimpType, created);
            const notifications = [];
            if (exceededParams.length > 0) {
                // Alert the farm owner and active technician/expert atomically with the observation.
                const assignments = await tx.seasonPersonnelAssignment.findMany({
                    where: { seasonId, unassignedAt: null },
                    select: { role: true, accountId: true },
                });
                const recipients = new Set([season.pond.farm.ownerId]);
                for (const assignment of assignments) {
                    if (assignment.role === PERSONNEL_ROLE.TECHNICIAN
                        || assignment.role === PERSONNEL_ROLE.EXPERT) {
                        recipients.add(assignment.accountId);
                    }
                }
                const content = buildThresholdAlertContent(season, exceededParams);
                for (const recipientId of recipients) {
                    const notification = await tx.notification.create({
                        data: {
                            accountId: recipientId,
                            title: 'Cảnh báo chất lượng nước',
                            content,
                            type: NOTIFICATION_TYPE.WATER_THRESHOLD_EXCEEDED,
                            referenceType: 'water_quality_log',
                            referenceId: created.id,
                        },
                        select: { id: true },
                    });
                    notifications.push({ accountId: recipientId, notificationId: notification.id });
                }
            }
            return {
                log: created,
                exceeded: exceededParams,
                notifications,
            };
        });

        // Dispatch real-time socket events only after the transaction has successfully committed.
        for (const notification of notifications) {
            emitNotification(notification.accountId, 'notification:new', { id: notification.notificationId });
        }

        idempotencySet(key, { status: 'done', fingerprint, logId: log.id });
        return { log: normalizeLog(log, season.shrimpType), duplicate: false, exceeded };
    } catch (error) {
        idempotencyStore.delete(key);
        // Final guard against concurrent duplicate submissions: unique(season_id, recorded_at, recorded_by).
        if (error?.code === 'P2002') {
            throw ApiError.conflict(messages.WATER_LOG.DUPLICATE_LOG);
        }
        if (error?.code === 'P2034'
            || (error?.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code))) {
            throw ApiError.conflict(messages.WATER_LOG.CHANGE_CONFLICT);
        }
        throw error;
    }
};

 

/**
 * List season water logs after resolving technician, expert or owner access.
 * Filter in the database before pagination; legacy reads exclude voided logs.
 */
const warningWhereFor = (shrimpType) => {
    const thresholds = WATER_THRESHOLDS[shrimpType];
    if (!thresholds) throw new Error(`Unknown shrimp type: ${shrimpType}`);
    const conditions = [];
    for (const [field, key] of Object.entries(THRESHOLD_FIELD_MAP)) {
        const { min, max } = thresholds[key];
        // Strict comparisons preserve inclusive policy bounds; SQL NULL never matches.
        if (min !== null) conditions.push({ [field]: { lt: min } });
        if (max !== null) conditions.push({ [field]: { gt: max } });
    }
    return { AND: [{ isVoided: false }, { OR: conditions }] };
};

const listWaterLogs = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const { limit = 20, cursor, from, to, includeVoided = false, filter, includeCounts = false } = query;
    const scopeWhere = {
        seasonId,
        ...(from || to
            ? {
                recordedAt: {
                    ...(from && { gte: new Date(from) }),
                    ...(to && { lte: new Date(to) }),
                },
            }
            : {}),
    };
    const warningWhere = filter === 'warning' || includeCounts
        ? warningWhereFor(season.shrimpType) : null;
    const filterWhere = filter === 'warning' ? warningWhere
        : filter === 'voided' ? { isVoided: true }
            : filter === 'all' || includeVoided ? {} : { isVoided: false };
    const baseWhere = { AND: [scopeWhere, filterWhere] };
    const where = { AND: [scopeWhere, filterWhere] };
    if (cursor) {
        const { recordedAt, logId } = decodeCursor(cursor);
        where.AND.push({
            OR: [
                { recordedAt: { lt: recordedAt } },
                { recordedAt, id: { lt: logId } },
            ],
        });
    }

    const readPage = async (client) => {
        const rowsPromise = client.waterQualityLog.findMany({
            where, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: limit + 1,
        });
        if (!includeCounts) {
            const [rows, totalResults] = await Promise.all([
                rowsPromise, client.waterQualityLog.count({ where: baseWhere }),
            ]);
            return { rows, totalResults };
        }
        const [rows, all, voided, warning] = await Promise.all([
            rowsPromise,
            client.waterQualityLog.count({ where: scopeWhere }),
            client.waterQualityLog.count({ where: { AND: [scopeWhere, { isVoided: true }] } }),
            client.waterQualityLog.count({ where: { AND: [scopeWhere, warningWhere] } }),
        ]);
        const counts = { all, valid: all - voided, warning, voided };
        const totalResults = filter ? counts[filter] : includeVoided ? all : counts.valid;
        return { rows, totalResults, counts };
    };
    // Items and group counts share one read snapshot, without locking writes.
    const { rows, totalResults, counts } = includeCounts
        ? await prisma.$transaction(readPage, { isolationLevel: 'RepeatableRead' })
        : await readPage(prisma);

    const hasNextPage = rows.length > limit;
    const logs = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage
        ? encodeCursor({ recordedAt: logs[logs.length - 1].recordedAt, id: logs[logs.length - 1].id })
        : null;
    // Resolve the original recorder, including replaced personnel, once per page.
    const recorderIds = [...new Set(logs.map((log) => log.recordedBy).filter(Boolean))];
    const recorders = recorderIds.length > 0 ? await prisma.account.findMany({
        where: { id: { in: recorderIds } },
        select: { id: true, fullName: true },
    }) : [];
    const recorderNames = new Map(recorders.map((account) => [account.id, account.fullName]));

    return {
        logs: logs.map((log) => ({
            ...normalizeLog(log, season.shrimpType),
            recordedByName: recorderNames.get(log.recordedBy) ?? null,
        })),
        meta: { totalResults, hasNextPage, nextCursor, ...(counts && { counts }) },
    };
};



/**
 * Void an existing log with an audit reason while the assigned season is active.
 * Only the currently assigned technician can void a log. Measurements remain
 * unchanged, and a concurrent or repeated void is reported as a conflict.
 */
const voidWaterLog = async (accountId, seasonId, logId, voidReason) => {
    // Only currently assigned technicians are authorized to void water observations.
    const season = await resolveKtvScope(accountId, seasonId);

    const log = await prisma.waterQualityLog.findFirst({
        where: { id: logId, seasonId },
    });
    if (!log) {
        throw ApiError.notFound(messages.WATER_LOG.NOT_FOUND);
    }
    if (log.isVoided) {
        throw ApiError.conflict(messages.WATER_LOG.ALREADY_VOIDED);
    }
    // Voiding is restricted to active seasons; completed or cancelled seasons remain locked.
    if (season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.conflict(messages.WATER_LOG.VOID_FORBIDDEN_STATE);
    }

    let updated;
    try {
        updated = await prisma.waterQualityLog.update({
            where: { id: logId, seasonId, isVoided: false },
            data: {
                isVoided: true,
                voidedBy: accountId,
                voidedAt: new Date(),
                voidReason: voidReason.trim(),
            },
        });
    } catch (error) {
        if (error?.code === 'P2025') {
            throw ApiError.conflict(messages.WATER_LOG.ALREADY_VOIDED);
        }
        throw error;
    }

    // Dữ liệu phụ thuộc: không có FK trỏ vào water_quality_logs.
    // - Thống kê (F4) tự loại bản void (WHERE is_voided = FALSE).
    // - Notification water_threshold_exceeded đã gửi giữ nguyên như fact lịch sử (BR-DATA-01).
    return normalizeLog(updated, season.shrimpType);
};



const bucketKeyOf = (date, granularity) => {
    // Calendar date bucketing follows farm local time (Asia/Ho_Chi_Minh, UTC+7).
    const shifted = new Date(date.getTime() + FARM_TZ_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = shifted.getUTCDate();
    if (granularity === 'week') {
        // Weekly grouping anchors to Monday as the start of the week.
        const dow = (shifted.getUTCDay() + 6) % 7;
        const monday = new Date(Date.UTC(y, shifted.getUTCMonth(), d - dow));
        return monday.toISOString().slice(0, 10);
    }
    return `${y}-${m}-${String(d).padStart(2, '0')}`;
};

/**
 * Aggregate valid water logs after resolving technician, expert or owner access.
 * Default to all recorded history through now and group daily or weekly series in farm time
 * (UTC+7). Voided logs are counted separately and excluded from measurements
 * and threshold exceedance rates.
 */
const getStatistics = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const requestedFrom = query.from === undefined ? null : new Date(query.from);
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const granularity = query.granularity || 'day';
    if (!Number.isFinite(to.getTime())
        || (requestedFrom && (!Number.isFinite(requestedFrom.getTime()) || requestedFrom > to))) {
        throw ApiError.badRequest(messages.WATER_LOG.INVALID_DATE_RANGE);
    }

    const rows = await prisma.waterQualityLog.findMany({
        where: {
            seasonId,
            isVoided: false,
            recordedAt: { ...(requestedFrom ? { gte: requestedFrom } : {}), lte: to },
        },
        orderBy: { recordedAt: 'asc' },
    });
    // Reuse the sorted valid rows instead of querying the earliest reading separately.
    const from = requestedFrom ?? rows[0]?.recordedAt ?? to;

    const summary = {};
    for (const field of METRIC_FIELDS) {
        summary[field] = {
            count: 0, min: null, max: null, sum: 0, exceedCount: 0, belowMinCount: 0, aboveMaxCount: 0,
        };
    }
    const buckets = new Map();

    for (const row of rows) {
        const values = {};
        for (const field of METRIC_FIELDS) {
            const v = toNumberOrNull(row[field]);
            values[field] = v;
            if (v !== null) {
                const s = summary[field];
                s.count += 1;
                s.sum += v;
                s.min = s.min === null ? v : Math.min(s.min, v);
                s.max = s.max === null ? v : Math.max(s.max, v);
            }
        }
        for (const exceeded of checkWaterThresholds(season.shrimpType, values)) {
            const stat = summary[exceeded.field];
            stat.exceedCount += 1;
            if (exceeded.direction === 'below_min') {
                stat.belowMinCount += 1;
            } else if (exceeded.direction === 'above_max') {
                stat.aboveMaxCount += 1;
            }
        }

        const bucket = bucketKeyOf(row.recordedAt, granularity);
        if (!buckets.has(bucket)) {
            const init = {};
            for (const field of METRIC_FIELDS) {
                init[field] = { count: 0, min: null, max: null, sum: 0 };
            }
            buckets.set(bucket, init);
        }
        const b = buckets.get(bucket);
        for (const field of METRIC_FIELDS) {
            const v = values[field];
            if (v !== null) {
                b[field].count += 1;
                b[field].sum += v;
                b[field].min = b[field].min === null ? v : Math.min(b[field].min, v);
                b[field].max = b[field].max === null ? v : Math.max(b[field].max, v);
            }
        }
    }

    const parameters = {};
    for (const field of METRIC_FIELDS) {
        const s = summary[field];
        if (s.count === 0) continue;
        parameters[field] = {
            count: s.count,
            min: s.min,
            max: s.max,
            avg: s.sum / s.count,
            exceedCount: s.exceedCount,
            exceedanceRate: s.exceedCount / s.count,
            belowMinCount: s.belowMinCount,
            aboveMaxCount: s.aboveMaxCount,
            belowMinRate: s.belowMinCount / s.count,
            aboveMaxRate: s.aboveMaxCount / s.count,
        };
    }

    const series = [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([bucket, b]) => {
            const point = { bucket };
            for (const field of METRIC_FIELDS) {
                if (b[field].count === 0) continue;
                point[field] = {
                    count: b[field].count,
                    avg: b[field].sum / b[field].count,
                    min: b[field].min,
                    max: b[field].max,
                };
            }
            return point;
        });

    const voidedRecords = await prisma.waterQualityLog.count({
        where: { seasonId, isVoided: true, recordedAt: { gte: from, lte: to } },
    });

    return {
        seasonId,
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        summary: {
            totalRecords: rows.length + voidedRecords,
            validRecords: rows.length,
            voidedRecords,
            parameters,
        },
        series,
    };
};

module.exports = {
    getMetadata,
    createWaterLog,
    listWaterLogs,
    voidWaterLog,
    getStatistics,
    // Internal exports for test isolation
    _bucketKeyOf: bucketKeyOf,
    _checkWaterThresholds: checkWaterThresholds,
};
