const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    messages,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    NOTIFICATION_TYPE,
    checkWaterThresholds,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

/**
 * Service cho nhật ký đo nước (water_quality_logs).
 *
 * Business rules (smartshrimp.sql):
 * - BR-OPS-01: chỉ KTV đang được phân công được ghi nhật ký cho vụ ACTIVE.
 * - BR-WATER-01: bản ghi bất biến sau khi tạo; sai chỉ được void bởi KTV
 *   đương nhiệm kèm người/thời gian/lý do.
 * - BR-ARCH-01: kiểm tra quyền + ghi notification trong transaction tường minh.
 * - BR-ARCH-03: không SELECT FOR UPDATE cho các read thông thường.
 */

const RECORDED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // D3: +5 phút
const STATISTICS_MAX_RANGE_DAYS = 90;
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
            isDeleted: true,
            farm: {
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    isDeleted: true,
                },
            },
        },
    },
};

// ---------------------------------------------------------------------------
// Phạm vi truy cập (scope)
// ---------------------------------------------------------------------------

const findSeason = (seasonId) =>
    prisma.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: SEASON_WITH_FARM_SELECT,
    });

const hasActiveAssignment = (accountId, seasonId, role) =>
    prisma.seasonPersonnelAssignment.findFirst({
        where: { seasonId, accountId, role, unassignedAt: null },
        select: { id: true },
    });

/**
 * KTV: phải có assignment technician đang hiệu lực trên vụ.
 * requireActiveSeason=true cho các thao tác ghi (BR-OPS-01).
 */
const resolveKtvScope = async (accountId, seasonId, { requireActiveSeason = false } = {}) => {
    const season = await findSeason(seasonId);
    if (!season) {
        throw ApiError.notFound(messages.WATER_LOG.NOT_FOUND);
    }
    const assignment = await hasActiveAssignment(accountId, seasonId, PERSONNEL_ROLE.TECHNICIAN);
    if (!assignment) {
        throw ApiError.forbidden(messages.WATER_LOG.NO_ASSIGNMENT);
    }
    if (requireActiveSeason && season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.conflict(messages.WATER_LOG.SEASON_NOT_ACTIVE);
    }
    return season;
};

/** Chuyên gia: assignment expert đang hiệu lực (chỉ đọc). */
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

/** Chủ trại: vụ thuộc trại mình sở hữu (chỉ đọc). */
const resolveOwnerScope = async (accountId, seasonId) => {
    const season = await findSeason(seasonId);
    if (
        !season ||
        season.pond.isDeleted ||
        season.pond.farm.isDeleted ||
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

// ---------------------------------------------------------------------------
// Chuẩn hóa output
// ---------------------------------------------------------------------------

const toNumberOrNull = (value) =>
    value === null || value === undefined ? null : Number(value);

const toIsoOrNull = (value) =>
    value === null || value === undefined ? null : value.toISOString();

const normalizeLog = (log, shrimpType) => {
    const values = {};
    for (const field of METRIC_FIELDS) {
        values[field] = toNumberOrNull(log[field]);
    }
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
        exceededParameters: checkWaterThresholds(shrimpType, values).map((e) => e.field),
    };
};

// ---------------------------------------------------------------------------
// Cursor pagination (cùng pattern với assignedSeason.service.js)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Idempotency cho POST create (D4) — best-effort trên single instance.
// accountId + seasonId + key -> { status, fingerprint, logId, expiresAt }.
// Triển khai đa instance nên thay bằng Redis; unique constraint
// (season_id, recorded_at, recorded_by) ở DB là tuyến cuối cùng.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// F1 — Nhập nhật ký đo nước
// ---------------------------------------------------------------------------

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
        const { log, exceeded, ownerId, notificationId } = await prisma.$transaction(async (tx) => {
            const created = await tx.waterQualityLog.create({
                data: {
                    seasonId,
                    recordedBy: accountId,
                    recordedAt,
                    ...metricData,
                    note,
                },
            });

            const exceededParams = checkWaterThresholds(season.shrimpType, metricData);
            let createdNotificationId = null;
            if (exceededParams.length > 0) {
                // BR-NOTI-03: chủ trại nhận cảnh báo nước — cùng transaction với log.
                const notification = await tx.notification.create({
                    data: {
                        accountId: season.pond.farm.ownerId,
                        title: 'Cảnh báo chất lượng nước',
                        content: buildThresholdAlertContent(season, exceededParams),
                        type: NOTIFICATION_TYPE.WATER_THRESHOLD_EXCEEDED,
                        referenceType: 'water_quality_log',
                        referenceId: created.id,
                    },
                    select: { id: true },
                });
                createdNotificationId = notification.id;
            }
            return {
                log: created,
                exceeded: exceededParams,
                ownerId: season.pond.farm.ownerId,
                notificationId: createdNotificationId,
            };
        });

        // Emit socket SAU khi transaction đã commit (tránh báo tin chưa chắc chắn).
        if (notificationId) {
            emitNotification(ownerId, 'notification:new', { id: notificationId });
        }

        idempotencySet(key, { status: 'done', fingerprint, logId: log.id });
        return { log: normalizeLog(log, season.shrimpType), duplicate: false, exceeded };
    } catch (error) {
        idempotencyStore.delete(key);
        // Tuyến cuối chống double-submit: unique(season_id, recorded_at, recorded_by).
        if (error?.code === 'P2002') {
            throw ApiError.conflict(messages.WATER_LOG.DUPLICATE_LOG);
        }
        throw error;
    }
};

 // ---------------------------------------------------------------------------
// F2 — Danh sách nhật ký đo nước
// ---------------------------------------------------------------------------

const listWaterLogs = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const { limit = 20, cursor, from, to, includeVoided = false } = query;
    const baseWhere = {
        seasonId,
        ...(includeVoided ? {} : { isVoided: false }),
        ...(from || to
            ? {
                recordedAt: {
                    ...(from && { gte: new Date(from) }),
                    ...(to && { lte: new Date(to) }),
                },
            }
            : {}),
    };

    let where = baseWhere;
    if (cursor) {
        const { recordedAt, logId } = decodeCursor(cursor);
        where = {
            ...baseWhere,
            OR: [
                { recordedAt: { lt: recordedAt } },
                { recordedAt, id: { lt: logId } },
            ],
        };
    }

    const [rows, totalResults] = await Promise.all([
        prisma.waterQualityLog.findMany({
            where,
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
        }),
        prisma.waterQualityLog.count({ where: baseWhere }),
    ]);

    const hasNextPage = rows.length > limit;
    const logs = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage
        ? encodeCursor({ recordedAt: logs[logs.length - 1].recordedAt, id: logs[logs.length - 1].id })
        : null;

    return {
        logs: logs.map((log) => normalizeLog(log, season.shrimpType)),
        meta: { totalResults, hasNextPage, nextCursor },
    };
};

// ---------------------------------------------------------------------------
// F3 — Hủy hiệu lực nhật ký đo nước
// ---------------------------------------------------------------------------

const voidWaterLog = async (accountId, seasonId, logId, voidReason) => {
    // BR-WATER-01: chỉ KTV đương nhiệm (assignment đang hiệu lực) được void.
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
    // D2: chỉ vụ ACTIVE mới được void (khóa sổ khi planning/completed/cancelled).
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

// ---------------------------------------------------------------------------
// F4 — Thống kê chất lượng nước (chỉ bản ghi hợp lệ: is_voided = FALSE)
// ---------------------------------------------------------------------------

const bucketKeyOf = (date, granularity) => {
    // Bucket theo giờ trại (Asia/Saigon, UTC+7, không DST).
    const shifted = new Date(date.getTime() + FARM_TZ_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = shifted.getUTCDate();
    if (granularity === 'week') {
        // Đầu tuần = thứ Hai.
        const dow = (shifted.getUTCDay() + 6) % 7;
        const monday = new Date(Date.UTC(y, shifted.getUTCMonth(), d - dow));
        return monday.toISOString().slice(0, 10);
    }
    return `${y}-${m}-${String(d).padStart(2, '0')}`;
};

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
        throw ApiError.badRequest(messages.WATER_LOG.INVALID_DATE_RANGE);
    }

    const rows = await prisma.waterQualityLog.findMany({
        where: {
            seasonId,
            isVoided: false,
            recordedAt: { gte: from, lte: to },
        },
        orderBy: { recordedAt: 'asc' },
    });

    const summary = {};
    for (const field of METRIC_FIELDS) {
        summary[field] = { count: 0, min: null, max: null, sum: 0, exceedCount: 0 };
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
        const exceeded = new Set(
            checkWaterThresholds(season.shrimpType, values).map((e) => e.field),
        );
        for (const field of METRIC_FIELDS) {
            if (values[field] !== null && exceeded.has(field)) {
                summary[field].exceedCount += 1;
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
            exceedanceRate: s.exceedCount / s.count,
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
    createWaterLog,
    listWaterLogs,
    voidWaterLog,
    getStatistics,
    // export cho test
    _bucketKeyOf: bucketKeyOf,
    _checkWaterThresholds: checkWaterThresholds,
};
