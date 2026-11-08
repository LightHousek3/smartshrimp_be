const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const config = require('../config');
const { ApiError, productionSchedule: scheduleRules } = require('../utils');
const { readSources, populationMatches } = require('./seasonBiomass.service');
const {
    ACCOUNT_ROLE, ACCOUNT_STATUS, FARM_STATUS, SEASON_STATUS, PERSONNEL_ROLE,
    OPERATION_STATUS, PROTOCOL_STATUS, PROTOCOL_TYPE, TASK_OPEN_STATUSES,
    WATER_THRESHOLDS, checkWaterThresholds, PRODUCTION_PROTOCOL_LIMITS,
    TECHNICIAN_DASHBOARD_LIMITS: limits, TECHNICIAN_ALERT_KIND: kind, messages,
} = require('../constants');

const DAY_MS = 86400000;
const context = (season) => ({ seasonId: season.id, seasonName: season.name,
    pondName: season.pond.name, farmName: season.pond.farm.name });

/** Scope first: neither a stale assignment nor a client-supplied ID grants another owner's records. */
const readScope = async (tx, accountId) => {
    const account = await tx.account.findFirst({
        where: { id: accountId, role: ACCOUNT_ROLE.TECHNICIAN, status: ACCOUNT_STATUS.ACTIVE,
            managedByOwner: { role: ACCOUNT_ROLE.FARM_OWNER, status: ACCOUNT_STATUS.ACTIVE } },
        select: { managedByOwnerId: true },
    });
    if (!account?.managedByOwnerId) throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    const seasons = await tx.aquacultureSeason.findMany({
        where: { status: SEASON_STATUS.ACTIVE,
            personnelAssignments: { some: { accountId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null } },
            pond: { farm: { ownerId: account.managedByOwnerId, status: FARM_STATUS.ACTIVE } } },
        select: { id: true, name: true, shrimpType: true, stockingDate: true,
            pond: { select: { name: true, volumeM3: true, farm: { select: { name: true } } } },
            _count: { select: { diseaseCases: { where: { status: { not: 'RESOLVED' } } } } },
        },
        orderBy: [{ stockingDate: 'desc' }, { id: 'asc' }],
    });
    return { ownerId: account.managedByOwnerId, seasons };
};

/** One Vietnam calendar day; the dashboard deliberately does not expose tomorrow's schedules. */
const dayWindow = (now) => {
    const date = scheduleRules.dateInVietnam(now);
    const start = new Date(`${date}T00:00:00+07:00`);
    return { date, start, end: new Date(start.getTime() + DAY_MS) };
};

// Respect the existing protocol/case lifecycle without introducing new treatment workflow here.
const effectiveProtocol = {
    status: PROTOCOL_STATUS.APPROVED,
    OR: [
        { protocolType: PROTOCOL_TYPE.PRODUCTION, season: { diseaseCases: { none: { status: 'IN_TREATMENT' } } } },
        { protocolType: PROTOCOL_TYPE.TREATMENT, diseaseCase: { status: 'IN_TREATMENT' } },
    ],
};
const plannedWhere = (ids) => ({ seasonId: { in: ids }, status: OPERATION_STATUS.PLANNED,
    protocolItem: { protocol: effectiveProtocol } });

/**
 * Prisma cannot express DISTINCT ON for the newest non-null reading of each metric.
 * A partial pH observation must not clear the previous NO2 observation. SQL values
 * are bound and scoped to already authorized seasons; no historical log body leaves this service.
 */
const readWaterAlerts = async (tx, seasons, now) => {
    if (!seasons.length) return [];
    const rows = await tx.$queryRaw(Prisma.sql`
        SELECT DISTINCT ON (l.season_id, metric.field)
            l.season_id AS "seasonId", l.id, l.recorded_at AS "recordedAt", metric.field, metric.value
        FROM water_quality_logs l
        CROSS JOIN LATERAL (VALUES
            ('temperatureC', l.temperature_c), ('ph', l.ph),
            ('dissolvedOxygenMgL', l.dissolved_oxygen_mg_l), ('salinityPpt', l.salinity_ppt),
            ('nh3MgL', l.nh3_mg_l), ('no2MgL', l.no2_mg_l),
            ('alkalinityMgLCaCO3', l.alkalinity_mg_l_caco3), ('h2sMgL', l.h2s_mg_l)
        ) metric(field, value)
        WHERE NOT l.is_voided AND l.recorded_at <= ${now} AND metric.value IS NOT NULL
            AND l.season_id IN (${Prisma.join(seasons.map(s => Prisma.sql`${s.id}::uuid`))})
        ORDER BY l.season_id, metric.field, l.recorded_at DESC, l.created_at DESC, l.id DESC`);
    const byId = new Map(seasons.map(s => [s.id, s]));
    const groups = new Map();
    for (const row of rows) {
        const season = byId.get(row.seasonId);
        const exceeded = checkWaterThresholds(season.shrimpType, { [row.field]: row.value });
        if (!exceeded.length) continue;
        const group = groups.get(season.id) ?? { id: `${kind.WATER}:${season.id}`, kind: kind.WATER,
            ...context(season), count: 0, metrics: [], observedAt: row.recordedAt };
        group.metrics.push({ field: row.field, value: Number(row.value), ...WATER_THRESHOLDS[season.shrimpType][row.field],
            recordedAt: row.recordedAt });
        group.count++;
        if (row.recordedAt > group.observedAt) group.observedAt = row.recordedAt;
        groups.set(season.id, group);
    }
    return [...groups.values()];
};

/** Keep original source times; no harvest-derived weight or copied daily observation renews biomass. */
const usableSource = (source) => source?.recordedAt && populationMatches(source)
    && (!source.latestPartialHarvestAt || source.recordedAt > source.latestPartialHarvestAt)
    ? source : null;

/**
 * Evaluate only today's missing, eligible production-v2 occurrences with the existing calculator.
 * This read never runs the generator. A cancelled/completed slot is history, not a generation failure.
 * Disabled workers and periods without an applicable occurrence do not imply a missing-biomass alert.
 */
const readBlockedAlerts = async (tx, seasons, now, window, sources) => {
    if (!seasons.length || !config.productionProtocol.v2Enabled || !config.productionProtocol.scheduleWorkerEnabled) return [];
    const ids = seasons.map(s => s.id);
    const [protocols, slots] = await Promise.all([
        tx.protocol.findMany({ where: { seasonId: { in: ids }, protocolType: PROTOCOL_TYPE.PRODUCTION,
            status: PROTOCOL_STATUS.APPROVED, contentVersion: 2,
            season: { diseaseCases: { none: { status: 'IN_TREATMENT' } } } },
        include: { items: { orderBy: { sequenceOrder: 'asc' } } } }),
        tx.operationSchedule.findMany({ where: { seasonId: { in: ids }, scheduledAt: { gte: now, lt: window.end } },
            select: { protocolItemId: true, scheduledAt: true } }),
    ]);
    if (!protocols.length) return [];
    const keys = new Set(slots.map(s => `${s.protocolItemId}:${s.scheduledAt.toISOString()}`));
    const byId = new Map(seasons.map(s => [s.id, s]));
    const alerts = [];
    for (const protocol of protocols) {
        const season = byId.get(protocol.seasonId);
        const source = usableSource(sources.get(season.id));
        const blocked = [];
        for (const { item, doc, scheduledAt } of scheduleRules.occurrences({ ...protocol, season }, now)) {
            if (scheduledAt >= window.end || keys.has(`${item.id}:${scheduledAt.toISOString()}`)) continue;
            // Unresolved materials belong to their own approval flow; do not mislabel them as biomass failures.
            if (!item.productId || !item.materialSnapshot) continue;
            const calculation = scheduleRules.calculate(item, doc, scheduledAt, { now,
                volumeM3: season.pond.volumeM3, healthLogs: source ? [source] : [],
                biomassMaxAgeHours: PRODUCTION_PROTOCOL_LIMITS.biomassMaxAgeHours });
            if (['BIOMASS_MISSING_OR_STALE', 'VOLUME_MISSING'].includes(calculation.blocked)) {
                blocked.push({ code: calculation.blocked, scheduledAt });
            }
        }
        if (blocked.length) {
            blocked.sort((a, b) => a.scheduledAt - b.scheduledAt);
            alerts.push({ id: `${kind.SCHEDULE_BLOCKED}:${season.id}`, kind: kind.SCHEDULE_BLOCKED,
                ...context(season), count: blocked.length, observedAt: blocked[0].scheduledAt,
                reasonCodes: [...new Set(blocked.map(b => b.code))] });
        }
    }
    return alerts;
};

/** Read current facts, never another user's inbox or notification read/resolved assumptions. */
const readAlerts = async (tx, seasons, now, window, sources) => {
    if (!seasons.length) return [];
    const ids = seasons.map(s => s.id);
    const [water, overdue, blocked] = await Promise.all([
        readWaterAlerts(tx, seasons, now),
        tx.operationSchedule.groupBy({ by: ['seasonId'], where: { ...plannedWhere(ids), scheduledAt: { lt: now } },
            _count: { _all: true }, _min: { scheduledAt: true } }),
        readBlockedAlerts(tx, seasons, now, window, sources),
    ]);
    const byId = new Map(seasons.map(s => [s.id, s]));
    const order = { [kind.SCHEDULE_BLOCKED]: 0, [kind.OVERDUE_OPERATIONS]: 1, [kind.WATER]: 2 };
    return [...blocked, ...overdue.map(row => ({ id: `${kind.OVERDUE_OPERATIONS}:${row.seasonId}`,
        kind: kind.OVERDUE_OPERATIONS, ...context(byId.get(row.seasonId)), count: row._count._all,
        observedAt: row._min.scheduledAt })), ...water]
        .sort((a, b) => order[a.kind] - order[b.kind] || a.observedAt - b.observedAt || a.id.localeCompare(b.id));
};

/** Today's actual PLANNED rows, grouped without capping seasons or silently mixing in tomorrow. */
const readOperations = async (tx, seasons, now, window) => {
    if (!seasons.length) return [];
    const rows = await tx.operationSchedule.findMany({
        where: { ...plannedWhere(seasons.map(s => s.id)), scheduledAt: { gte: now, lt: window.end } },
        select: { id: true, seasonId: true, operationType: true, scheduledAt: true, plannedQuantity: true, unit: true,
            product: { select: { id: true, name: true } },
            protocolItem: { select: { materialSnapshot: true, protocol: { select: { seasonId: true } } } } },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
    const byId = new Map(seasons.map(s => [s.id, s]));
    const groups = new Map();
    for (const row of rows) {
        if (row.protocolItem.protocol.seasonId !== row.seasonId) continue;
        const group = groups.get(row.seasonId) ?? { ...context(byId.get(row.seasonId)), items: [] };
        const snapshot = row.protocolItem.materialSnapshot;
        group.items.push({ id: row.id, operationType: row.operationType, scheduledAt: row.scheduledAt,
            productName: snapshot?.id === row.product?.id ? snapshot.name : row.product?.name ?? null,
            plannedQuantity: Number(row.plannedQuantity), unit: row.unit });
        groups.set(row.seasonId, group);
    }
    return [...groups.values()];
};

/** Preview the latest measured snapshot, explicitly separating missing/stale/post-harvest data. */
const presentSeason = (season, sources, now, date) => {
    const source = sources.get(season.id);
    let biomassState = 'MISSING';
    if (source?.recordedAt) {
        biomassState = source.latestPartialHarvestAt && source.recordedAt <= source.latestPartialHarvestAt ? 'AFTER_HARVEST'
            : !populationMatches(source) ? 'POPULATION_CHANGED'
                : now - source.recordedAt > PRODUCTION_PROTOCOL_LIMITS.biomassMaxAgeHours * 3600000 ? 'STALE' : 'RECORDED';
    } else if (source?.latestPartialHarvestAt) biomassState = 'AFTER_HARVEST';
    return { ...context(season), cultureDay: season.stockingDate
        ? Math.floor((Date.parse(date) - season.stockingDate.getTime()) / DAY_MS) + 1 : null,
    biomassState, biomassKg: biomassState === 'RECORDED' || biomassState === 'STALE' ? Number(source.estimatedBiomassKg) : null,
    biomassRecordedAt: source?.recordedAt ?? null };
};

/**
 * Read one coherent home snapshot. Tasks follow their assignee, including farm-level
 * work and unfinished tasks of closed seasons; active-season scope must not hide them.
 * No generation, execution, notification writes or stock changes occur on this path.
 */
const getOverview = (accountId, now = new Date()) => prisma.$transaction(async (tx) => {
    const { ownerId, seasons } = await readScope(tx, accountId);
    const window = dayWindow(now);
    const taskWhere = { assignedTo: accountId, status: { in: TASK_OPEN_STATUSES }, farm: { ownerId } };
    const sources = await readSources(tx, seasons.map(s => s.id), now);
    const [openTaskCount, tasks, alerts, operationGroups] = await Promise.all([
        tx.task.count({ where: taskWhere }),
        tx.task.findMany({ where: taskWhere, select: { id: true, title: true, priority: true, status: true, dueAt: true },
            orderBy: [{ priority: 'desc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }], take: limits.tasks }),
        readAlerts(tx, seasons, now, window, sources),
        readOperations(tx, seasons, now, window),
    ]);
    return { date: window.date, serverNow: now, dayEndExclusive: window.end,
        summary: { activeSeasonCount: seasons.length, openTaskCount,
            unresolvedActiveSeasonCaseCount: seasons.reduce((sum, s) => sum + s._count.diseaseCases, 0) },
        alerts, tasks, operationGroups,
        seasons: seasons.slice(0, limits.seasons).map(s => presentSeason(s, sources, now, window.date)) };
}, { isolationLevel: 'RepeatableRead' });

module.exports = { getOverview };
