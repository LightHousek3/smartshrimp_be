const prisma = require('../config/prisma');
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
 * Service cho nhật ký sức khỏe tôm (shrimp_health_logs).
 *
 * Business rules:
 * - BR-OPS-01: Chỉ KTV đang được phân công được ghi nhận / hủy nhật ký sức khỏe cho vụ ACTIVE.
 * - BR-HEALTH-01: Bản ghi sức khỏe là bất biến (immutable) sau khi tạo; sai sót chỉ được hủy
 *   (void) bởi KTV đương nhiệm kèm người hủy, thời gian và lý do hủy (void_reason).
 *   Chỉ bản ghi chưa hủy (is_voided = false) mới được đưa vào tính toán thống kê,
 *   tăng trưởng và làm căn cứ sinh lịch vận hành theo sinh khối.
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

// ---------------------------------------------------------------------------
// Phạm vi truy cập (Scope resolvers)
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

// ---------------------------------------------------------------------------
// Helpers chuyển đổi & chuẩn hóa
// ---------------------------------------------------------------------------

const toNumberOrNull = (value) =>
    value === null || value === undefined ? null : Number(value);

const toIsoOrNull = (value) =>
    value === null || value === undefined ? null : value.toISOString();

const calculateDoc = (stockingDate, recordedAt) => {
    if (!stockingDate || !recordedAt) return null;
    const stock = new Date(stockingDate);
    const rec = new Date(recordedAt);
    const diffTime = rec.getTime() - stock.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(1, diffDays + 1);
};

const normalizeLog = (log, stockingDate, accountMap = {}) => {
    const recorder = accountMap[log.recordedBy] || null;
    const voider = log.voidedBy ? (accountMap[log.voidedBy] || null) : null;

    return {
        id: log.id,
        seasonId: log.seasonId,
        recordedBy: log.recordedBy,
        recordedByName: recorder?.fullName || null,
        recordedByEmail: recorder?.email || null,
        recordedAt: log.recordedAt.toISOString(),
        dayOfCulture: calculateDoc(stockingDate, log.recordedAt),
        sampleSize: log.sampleSize !== null && log.sampleSize !== undefined ? Number(log.sampleSize) : null,
        avgWeightG: toNumberOrNull(log.avgWeightG),
        avgLengthCm: toNumberOrNull(log.avgLengthCm),
        mortalityCount: log.mortalityCount !== null && log.mortalityCount !== undefined ? Number(log.mortalityCount) : 0,
        estimatedPopulation: log.estimatedPopulation !== null && log.estimatedPopulation !== undefined ? Number(log.estimatedPopulation) : null,
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

// ---------------------------------------------------------------------------
// Cursor Pagination
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
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.INVALID_CURSOR);
    }
};

// ---------------------------------------------------------------------------
// Idempotency store (in-memory)
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

const idempotencySet = (key, value) => {
    if (!key) return;
    idempotencyStore.set(key, { ...value, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
};

// ---------------------------------------------------------------------------
// UC 13: Ghi nhận sức khỏe tôm
// ---------------------------------------------------------------------------

const createShrimpHealthLog = async (accountId, seasonId, data, idempotencyKey = '') => {
    const season = await resolveKtvScope(accountId, seasonId, { requireActiveSeason: true });

    const recordedAt = new Date(data.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) {
        throw ApiError.badRequest('Thời điểm ghi nhận không hợp lệ');
    }
    if (recordedAt.getTime() > Date.now() + RECORDED_AT_FUTURE_TOLERANCE_MS) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.RECORDED_AT_TOO_FAR_FUTURE);
    }
    // BR-HEALTH: Chỉ cho phép ghi nhận quá khứ trong ngày hôm nay (farm timezone UTC+7)
    const nowFarm = new Date(Date.now() + FARM_TZ_OFFSET_MS);
    const startOfTodayFarm = new Date(Date.UTC(
        nowFarm.getUTCFullYear(),
        nowFarm.getUTCMonth(),
        nowFarm.getUTCDate(),
    ) - FARM_TZ_OFFSET_MS);

    if (recordedAt.getTime() < startOfTodayFarm.getTime()) {
        throw ApiError.badRequest('Chỉ được ghi nhận sức khỏe tôm trong ngày hôm nay');
    }

    let sampleSize = data.sampleSize !== undefined && data.sampleSize !== null ? Number(data.sampleSize) : null;
    let avgWeightG = data.avgWeightG !== undefined && data.avgWeightG !== null ? Number(data.avgWeightG) : null;
    let avgLengthCm = data.avgLengthCm !== undefined && data.avgLengthCm !== null ? Number(data.avgLengthCm) : null;
    let mortalityCount = data.mortalityCount !== undefined && data.mortalityCount !== null ? Number(data.mortalityCount) : 0;
    let estimatedPopulation = data.estimatedPopulation !== undefined && data.estimatedPopulation !== null ? Number(data.estimatedPopulation) : null;
    let estimatedBiomassKg = data.estimatedBiomassKg !== undefined && data.estimatedBiomassKg !== null ? Number(data.estimatedBiomassKg) : null;
    const healthStatus = data.healthStatus || HEALTH_STATUS.GOOD;
    const note = (data.note || '').trim() || null;

    // BR-HEALTH: Số lượng tôm ước tính không được vượt quá số giống thả ban đầu
    const initialQty = season.initialQuantity !== null && season.initialQuantity !== undefined ? Number(season.initialQuantity) : null;
    if (initialQty && initialQty > 0 && estimatedPopulation !== null && estimatedPopulation > initialQty) {
        throw ApiError.badRequest(`Ước tính đàn (${estimatedPopulation.toLocaleString('vi-VN')} con) không được vượt quá số lượng giống thả ban đầu (${initialQty.toLocaleString('vi-VN')} con)`);
    }

    // Tự động tính sinh khối nếu có ước tính số lượng và trọng lượng TB mà chưa có sinh khối
    if (estimatedBiomassKg === null && estimatedPopulation !== null && avgWeightG !== null && estimatedPopulation > 0 && avgWeightG > 0) {
        estimatedBiomassKg = Math.round((estimatedPopulation * avgWeightG / 1000) * 1000) / 1000;
    }

    // Idempotency check
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
            return { log: normalizeLog(existing, season.stockingDate, accountMap), duplicate: true };
        }
    }
    if (prior?.status === 'processing') {
        throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.DUPLICATE_LOG);
    }
    idempotencySet(key, { status: 'processing', fingerprint });

    try {
        const created = await prisma.shrimpHealthLog.create({
            data: {
                seasonId,
                recordedBy: accountId,
                recordedAt,
                sampleSize,
                avgWeightG: avgWeightG !== null ? avgWeightG : undefined,
                avgLengthCm: avgLengthCm !== null ? avgLengthCm : undefined,
                mortalityCount: BigInt(mortalityCount),
                estimatedPopulation: estimatedPopulation !== null ? BigInt(estimatedPopulation) : undefined,
                estimatedBiomassKg: estimatedBiomassKg !== null ? estimatedBiomassKg : undefined,
                healthStatus,
                note,
            },
        });

        idempotencySet(key, { status: 'done', fingerprint, logId: created.id });

        const accountMap = await fetchAccountMap([created.recordedBy]);
        return { log: normalizeLog(created, season.stockingDate, accountMap), duplicate: false };
    } catch (error) {
        idempotencyStore.delete(key);
        throw error;
    }
};

// ---------------------------------------------------------------------------
// UC 14: Xem danh sách ghi nhận sức khỏe
// ---------------------------------------------------------------------------

const listShrimpHealthLogs = async (accountId, seasonId, query = {}, scope = 'ktv') => {
    const resolver = SCOPE_RESOLVERS[scope];
    if (!resolver) {
        throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    }
    const season = await resolver(accountId, seasonId);

    const where = { seasonId };

    // Filter theo ngày
    if (query.from || query.to) {
        where.recordedAt = {};
        if (query.from) where.recordedAt.gte = new Date(query.from);
        if (query.to) where.recordedAt.lte = new Date(query.to);
    }

    // Filter theo trạng thái sức khỏe
    if (query.healthStatus) {
        where.healthStatus = query.healthStatus;
    }

    // Filter theo hợp lệ / đã hủy
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

    // Thu thập IDs để lấy thông tin tài khoản (recordedBy, voidedBy)
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

// ---------------------------------------------------------------------------
// UC 15: Xem chi tiết ghi nhận sức khỏe
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UC 16: Hủy ghi nhận sức khỏe tôm
// ---------------------------------------------------------------------------

const voidShrimpHealthLog = async (accountId, seasonId, logId, { voidReason }) => {
    if (!voidReason || !voidReason.trim()) {
        throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.VOID_REASON_REQUIRED);
    }

    const season = await resolveKtvScope(accountId, seasonId);

    // BR-HEALTH: Chỉ được hủy hiệu lực bản ghi trong ngày hôm nay (farm timezone UTC+7)
    const nowFarm = new Date(Date.now() + FARM_TZ_OFFSET_MS);
    const startOfTodayFarm = new Date(Date.UTC(
        nowFarm.getUTCFullYear(),
        nowFarm.getUTCMonth(),
        nowFarm.getUTCDate(),
    ) - FARM_TZ_OFFSET_MS);

    const updated = await prisma.$transaction(async (tx) => {
        // Shared order with generation/execution: season first, then dependent schedules.
        await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
        const currentSeason = await tx.aquacultureSeason.findUnique({ where: { id: seasonId }, select: { status: true } });
        if (currentSeason?.status !== SEASON_STATUS.ACTIVE) {
            throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.VOID_FORBIDDEN_STATE);
        }
        const log = await tx.shrimpHealthLog.findFirst({ where: { id: logId, seasonId } });
        if (!log) throw ApiError.notFound(messages.SHRIMP_HEALTH_LOG.NOT_FOUND);
        if (log.isVoided) throw ApiError.conflict(messages.SHRIMP_HEALTH_LOG.ALREADY_VOIDED);
        if (new Date(log.recordedAt).getTime() < startOfTodayFarm.getTime()) {
            throw ApiError.badRequest(messages.SHRIMP_HEALTH_LOG.VOID_ONLY_TODAY);
        }
        const voidedAt = new Date();
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
            where: { seasonId, sourceHealthLogId: logId, status: OPERATION_STATUS.PLANNED, execution: null },
            data: { status: OPERATION_STATUS.CANCELLED, cancelledAt: voidedAt, cancelledBy: accountId,
                cancellationReason: messages.PRODUCTION_PROTOCOL.BIOMASS_SOURCE_VOIDED },
        });
        return tx.shrimpHealthLog.findFirst({ where: { id: logId, seasonId } });
    });

    const accountMap = await fetchAccountMap([updated.recordedBy, updated.voidedBy]);
    return normalizeLog(updated, season.stockingDate, accountMap);
};

// ---------------------------------------------------------------------------
// UC 17: Xem thống kê sức khỏe và tăng trưởng
// ---------------------------------------------------------------------------

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

    // Chỉ lấy bản ghi hợp lệ (isVoided = false)
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

        const mort = r.mortalityCount !== null && r.mortalityCount !== undefined ? Number(r.mortalityCount) : 0;
        totalMortality += mort;

        const dateKey = bucketKeyOf(r.recordedAt, granularity);
        const doc = calculateDoc(season.stockingDate, r.recordedAt);

        // Mỗi lần đo là một điểm dữ liệu trên chuỗi tăng trưởng
        growthSeries.push({
            date: dateKey,
            recordedAt: r.recordedAt.toISOString(),
            dayOfCulture: doc,
            avgWeightG: toNumberOrNull(r.avgWeightG),
            avgLengthCm: toNumberOrNull(r.avgLengthCm),
            estimatedBiomassKg: toNumberOrNull(r.estimatedBiomassKg),
            estimatedPopulation: r.estimatedPopulation !== null && r.estimatedPopulation !== undefined ? Number(r.estimatedPopulation) : null,
            mortalityCount: mort,
            healthStatus: r.healthStatus,
        });
    }

    // Bản ghi hợp lệ gần nhất trong vụ để hiển thị thẻ tóm tắt
    const latestValidLog = await prisma.shrimpHealthLog.findFirst({
        where: { seasonId, isVoided: false },
        orderBy: { recordedAt: 'desc' },
    });

    const initialQty = season.initialQuantity !== null && season.initialQuantity !== undefined ? Number(season.initialQuantity) : null;
    const currentPop = latestValidLog?.estimatedPopulation !== null && latestValidLog?.estimatedPopulation !== undefined ? Number(latestValidLog.estimatedPopulation) : null;

    let survivalRatePercent = null;
    if (initialQty && initialQty > 0 && currentPop !== null) {
        survivalRatePercent = Math.min(100, Math.max(0, Math.round((currentPop / initialQty) * 10000) / 100));
    }

    const totalValidLogs = rows.length;
    const healthDistribution = {
        totalLogs: totalValidLogs,
        excellent: {
            count: statusCounts.EXCELLENT,
            percent: totalValidLogs > 0 ? Math.round((statusCounts.EXCELLENT / totalValidLogs) * 1000) / 10 : 0,
        },
        good: {
            count: statusCounts.GOOD,
            percent: totalValidLogs > 0 ? Math.round((statusCounts.GOOD / totalValidLogs) * 1000) / 10 : 0,
        },
        warning: {
            count: statusCounts.WARNING,
            percent: totalValidLogs > 0 ? Math.round((statusCounts.WARNING / totalValidLogs) * 1000) / 10 : 0,
        },
        critical: {
            count: statusCounts.CRITICAL,
            percent: totalValidLogs > 0 ? Math.round((statusCounts.CRITICAL / totalValidLogs) * 1000) / 10 : 0,
        },
    };

    return {
        seasonId,
        shrimpType: season.shrimpType,
        stockingDate: season.stockingDate ? season.stockingDate.toISOString().slice(0, 10) : null,
        initialQuantity: initialQty,
        summary: {
            currentBiomassKg: toNumberOrNull(latestValidLog?.estimatedBiomassKg),
            currentAvgWeightG: toNumberOrNull(latestValidLog?.avgWeightG),
            currentAvgLengthCm: toNumberOrNull(latestValidLog?.avgLengthCm),
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

module.exports = {
    createShrimpHealthLog,
    listShrimpHealthLogs,
    getShrimpHealthLogDetail,
    voidShrimpHealthLog,
    getStatistics,
};
