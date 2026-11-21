const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError, productionSchedule: scheduleRules } = require('../utils');
const { readSources, populationMatches } = require('./seasonBiomass.service');
const { timingComparison, TIMING } = require('../utils/protocolExecution');
const { treatmentOccurrences, courseEndsAt, cultureDay } = require('../utils/protocolTimeline');
const lifecycle = require('./protocolLifecycle.service');
const {
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    FARM_STATUS,
    SEASON_STATUS,
    PERSONNEL_ROLE,
    OPERATION_STATUS,
    PROTOCOL_STATUS,
    PROTOCOL_TYPE,
    TASK_OPEN_STATUSES,
    WATER_THRESHOLDS,
    checkWaterThresholds,
    PRODUCTION_PROTOCOL_LIMITS,
    TECHNICIAN_DASHBOARD_LIMITS: limits,
    TECHNICIAN_ALERT_KIND: kind,
    messages,
} = require('../constants');

const DAY_MS = 86400000;
const context = (season) => ({
    seasonId: season.id,
    seasonName: season.name,
    pondName: season.pond.name,
    farmName: season.pond.farm.name,
});

/** Scope first: neither a stale assignment nor a client-supplied ID grants another owner's records. */
const readScope = async (tx, accountId) => {
    const account = await tx.account.findFirst({
        where: {
            id: accountId,
            role: ACCOUNT_ROLE.TECHNICIAN,
            status: ACCOUNT_STATUS.ACTIVE,
            managedByOwner: { role: ACCOUNT_ROLE.FARM_OWNER, status: ACCOUNT_STATUS.ACTIVE },
        },
        select: { managedByOwnerId: true },
    });
    if (!account?.managedByOwnerId) throw ApiError.forbidden(messages.AUTH.FORBIDDEN);
    const seasons = await tx.aquacultureSeason.findMany({
        where: {
            status: SEASON_STATUS.ACTIVE,
            personnelAssignments: {
                some: { accountId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null },
            },
            pond: { farm: { ownerId: account.managedByOwnerId, status: FARM_STATUS.ACTIVE } },
        },
        select: {
            id: true,
            name: true,
            shrimpType: true,
            stockingDate: true,
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

// Only effective prescriptions contribute to the technician's operational workload.
const effectiveProtocol = {
    status: PROTOCOL_STATUS.ACTIVE,
    OR: [
        {
            protocolType: PROTOCOL_TYPE.PRODUCTION,
            season: { diseaseCases: { none: { status: 'IN_TREATMENT' } } },
        },
        { protocolType: PROTOCOL_TYPE.TREATMENT, diseaseCase: { status: 'IN_TREATMENT' } },
    ],
};
const plannedWhere = (ids, protocols) => ({
    seasonId: { in: ids },
    status: OPERATION_STATUS.PLANNED,
    protocolItem: { protocolId: { in: [...protocols.keys()] } },
});

/** Apply the execution lifecycle even when a worker has not persisted a timed transition yet. */
const readProtocols = async (tx, seasons, now) => {
    if (!seasons.length) return new Map();
    const rows = await tx.protocol.findMany({
        where: { seasonId: { in: seasons.map((season) => season.id) }, ...effectiveProtocol },
        include: { items: { orderBy: { sequenceOrder: 'asc' } } },
    });
    const byId = new Map(seasons.map((season) => [season.id, season]));
    const protocols = new Map();
    for (const row of rows) {
        const protocol = { ...row, season: byId.get(row.seasonId) };
        const end = courseEndsAt(protocol);
        if (!end || now >= end) continue;
        if (
            row.protocolType === PROTOCOL_TYPE.TREATMENT &&
            (!row.treatmentStartAt || row.treatmentStartAt > now)
        )
            continue;
        if (
            row.protocolType === PROTOCOL_TYPE.PRODUCTION &&
            (await lifecycle.productionBlocked(tx, row.seasonId, now))
        )
            continue;
        const replacement = await lifecycle.nextTreatmentStart(tx, row.seasonId, row.id);
        if (replacement && now >= replacement) continue;
        protocols.set(row.id, {
            ...protocol,
            effectiveUntil: replacement && replacement < end ? replacement : end,
        });
    }
    return protocols;
};

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
            AND l.season_id IN (${Prisma.join(seasons.map((s) => Prisma.sql`${s.id}::uuid`))})
        ORDER BY l.season_id, metric.field, l.recorded_at DESC, l.created_at DESC, l.id DESC`);
    const byId = new Map(seasons.map((s) => [s.id, s]));
    const groups = new Map();
    for (const row of rows) {
        const season = byId.get(row.seasonId);
        const exceeded = checkWaterThresholds(season.shrimpType, { [row.field]: row.value });
        if (!exceeded.length) continue;
        const group = groups.get(season.id) ?? {
            id: `${kind.WATER}:${season.id}`,
            kind: kind.WATER,
            ...context(season),
            count: 0,
            metrics: [],
            observedAt: row.recordedAt,
        };
        group.metrics.push({
            field: row.field,
            value: Number(row.value),
            ...WATER_THRESHOLDS[season.shrimpType][row.field],
            recordedAt: row.recordedAt,
        });
        group.count++;
        if (row.recordedAt > group.observedAt) group.observedAt = row.recordedAt;
        groups.set(season.id, group);
    }
    return [...groups.values()];
};

/** Keep original source times; no harvest-derived weight or copied daily observation renews biomass. */
const usableSource = (source) =>
    source?.recordedAt &&
    populationMatches(source) &&
    (!source.latestPartialHarvestAt || source.recordedAt > source.latestPartialHarvestAt)
        ? source
        : null;

/**
 * Evaluate today's missing occurrences against the effective prescription.
 * This read never runs the generator. A cancelled/completed slot is history, not a generation failure.
 * Periods without an applicable occurrence do not imply a missing-biomass alert.
 */
const readBlockedAlerts = async (tx, seasons, now, window, sources, protocols) => {
    if (!protocols.size) return [];
    const ids = seasons.map((s) => s.id);
    const occurrencesByProtocol = new Map(
        [...protocols.values()].map((protocol) => [
            protocol.id,
            protocol.protocolType === PROTOCOL_TYPE.TREATMENT
                ? treatmentOccurrences(protocol, now)
                : scheduleRules.occurrences(protocol, now),
        ]),
    );
    const earliest = new Date(
        Math.min(
            window.start.getTime(),
            ...[...occurrencesByProtocol.values()].flat().map(({ scheduledAt }) => scheduledAt.getTime()),
        ),
    );
    const slots = await tx.operationSchedule.findMany({
        where: {
            seasonId: { in: ids },
            protocolItem: { protocolId: { in: [...protocols.keys()] } },
            scheduledAt: { gte: earliest, lt: window.end },
        },
        select: {
            protocolItemId: true,
            scheduledAt: true,
            status: true,
            cancellationType: true,
        },
    });
    const keys = new Set(
        slots
            .filter(
                (row) =>
                    row.status !== 'CANCELLED' ||
                    row.cancellationType !== 'CALCULATION_CHANGED' ||
                    row.scheduledAt <= now,
            )
            .map((s) => `${s.protocolItemId}:${s.scheduledAt.toISOString()}`),
    );
    const byId = new Map(seasons.map((s) => [s.id, s]));
    const sourcesAt = new Map([[now.toISOString(), sources]]);
    const alerts = [];
    for (const protocol of protocols.values()) {
        const season = byId.get(protocol.seasonId);
        const blocked = [];
        const occurrences = occurrencesByProtocol.get(protocol.id);
        for (const { item, doc, scheduledAt } of occurrences) {
            if (
                scheduledAt >= window.end ||
                scheduledAt >= protocol.effectiveUntil ||
                keys.has(`${item.id}:${scheduledAt.toISOString()}`)
            )
                continue;
            // Unresolved materials belong to their own approval flow; do not mislabel them as biomass failures.
            if (!item.productId || !item.materialSnapshot) continue;
            if (
                cultureDay(season.stockingDate, scheduledAt) < 30 &&
                ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(item.doseBasis)
            )
                continue;
            const at = scheduledAt < now ? scheduledAt : now;
            const key = at.toISOString();
            if (!sourcesAt.has(key)) sourcesAt.set(key, await readSources(tx, ids, at));
            const source = usableSource(sourcesAt.get(key).get(season.id));
            const calculation = scheduleRules.calculate(item, doc, scheduledAt, {
                now: at,
                volumeM3: season.pond.volumeM3,
                healthLogs: source ? [source] : [],
                biomassMaxAgeHours: PRODUCTION_PROTOCOL_LIMITS.biomassMaxAgeHours,
            });
            if (['BIOMASS_MISSING_OR_STALE', 'VOLUME_MISSING'].includes(calculation.blocked)) {
                blocked.push({ code: calculation.blocked, scheduledAt });
            }
        }
        if (blocked.length) {
            blocked.sort((a, b) => a.scheduledAt - b.scheduledAt);
            alerts.push({
                id: `${kind.SCHEDULE_BLOCKED}:${season.id}`,
                kind: kind.SCHEDULE_BLOCKED,
                ...context(season),
                count: blocked.length,
                observedAt: blocked[0].scheduledAt,
                reasonCodes: [...new Set(blocked.map((b) => b.code))],
            });
        }
    }
    return alerts;
};

/** Read current facts, never another user's inbox or notification read/resolved assumptions. */
const readAlerts = async (tx, seasons, now, window, sources, protocols) => {
    if (!seasons.length) return [];
    const ids = seasons.map((s) => s.id);
    const [water, overdue, blocked] = await Promise.all([
        readWaterAlerts(tx, seasons, now),
        tx.operationSchedule.findMany({
            where: { ...plannedWhere(ids, protocols), scheduledAt: { lt: now } },
            select: {
                seasonId: true,
                scheduledAt: true,
                status: true,
                protocolItem: { select: { dueAtMinutes: true, protocolId: true } },
            },
        }),
        readBlockedAlerts(tx, seasons, now, window, sources, protocols),
    ]);
    const byId = new Map(seasons.map((s) => [s.id, s]));
    const order = { [kind.SCHEDULE_BLOCKED]: 0, [kind.OVERDUE_OPERATIONS]: 1, [kind.WATER]: 2 };
    const groups = new Map();
    for (const row of overdue) {
        const protocol = protocols.get(row.protocolItem.protocolId);
        if (
            !protocol ||
            protocol.seasonId !== row.seasonId ||
            row.scheduledAt >= protocol.effectiveUntil
        )
            continue;
        if (timingComparison(row, row.protocolItem.dueAtMinutes, now).status !== TIMING.OVERDUE)
            continue;
        const group = groups.get(row.seasonId) ?? {
            id: `${kind.OVERDUE_OPERATIONS}:${row.seasonId}`,
            kind: kind.OVERDUE_OPERATIONS,
            ...context(byId.get(row.seasonId)),
            count: 0,
            observedAt: row.scheduledAt,
        };
        group.count++;
        if (row.scheduledAt < group.observedAt) group.observedAt = row.scheduledAt;
        groups.set(row.seasonId, group);
    }
    return [...blocked, ...groups.values(), ...water].sort(
        (a, b) =>
            order[a.kind] - order[b.kind] ||
            a.observedAt - b.observedAt ||
            a.id.localeCompare(b.id),
    );
};

/** Include still-open windows across midnight; tomorrow's occurrences stay outside today's overview. */
const readOperations = async (tx, seasons, now, window, protocols) => {
    if (!protocols.size) return [];
    const rows = await tx.operationSchedule.findMany({
        where: {
            ...plannedWhere(seasons.map((s) => s.id), protocols),
            scheduledAt: { lt: window.end },
        },
        select: {
            id: true,
            seasonId: true,
            operationType: true,
            scheduledAt: true,
            plannedQuantity: true,
            unit: true,
            product: { select: { id: true, name: true } },
            protocolItem: {
                select: {
                    dueAtMinutes: true,
                    materialSnapshot: true,
                    protocolId: true,
                },
            },
        },
        orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    });
    const byId = new Map(seasons.map((s) => [s.id, s]));
    const groups = new Map();
    for (const row of rows) {
        const protocol = protocols.get(row.protocolItem.protocolId);
        if (
            !protocol ||
            protocol.seasonId !== row.seasonId ||
            row.scheduledAt >= protocol.effectiveUntil
        )
            continue;
        const timing = timingComparison(row, row.protocolItem.dueAtMinutes, now);
        if (timing.status !== TIMING.PENDING) continue;
        const group = groups.get(row.seasonId) ?? { ...context(byId.get(row.seasonId)), items: [] };
        const snapshot = row.protocolItem.materialSnapshot;
        group.items.push({
            id: row.id,
            operationType: row.operationType,
            scheduledAt: row.scheduledAt,
            dueAt: timing.dueAt,
            productName:
                snapshot?.id === row.product?.id ? snapshot.name : (row.product?.name ?? null),
            plannedQuantity: Number(row.plannedQuantity),
            unit: row.unit,
        });
        groups.set(row.seasonId, group);
    }
    return [...groups.values()];
};

/** Preview the latest measured snapshot, explicitly separating missing/stale/post-harvest data. */
const presentSeason = (season, sources, now) => {
    const source = sources.get(season.id);
    const doc = cultureDay(season.stockingDate, now);
    let biomassState = 'MISSING';
    if (source?.recordedAt) {
        biomassState =
            source.latestPartialHarvestAt && source.recordedAt <= source.latestPartialHarvestAt
                ? 'AFTER_HARVEST'
                : !populationMatches(source)
                  ? 'POPULATION_CHANGED'
                  : now - source.recordedAt >
                      PRODUCTION_PROTOCOL_LIMITS.biomassMaxAgeHours * 3600000
                    ? 'STALE'
                    : 'RECORDED';
    } else if (source?.latestPartialHarvestAt) biomassState = 'AFTER_HARVEST';
    return {
        ...context(season),
        cultureDay: doc > 0 ? doc : null,
        biomassState,
        biomassKg:
            biomassState === 'RECORDED' || biomassState === 'STALE'
                ? Number(source.estimatedBiomassKg)
                : null,
        biomassRecordedAt: source?.recordedAt ?? null,
    };
};

/**
 * Read one coherent home snapshot. Tasks follow their assignee, including farm-level
 * work and unfinished tasks of closed seasons; active-season scope must not hide them.
 * No generation, execution, notification writes or stock changes occur on this path.
 */
const getOverview = (accountId, now = new Date()) =>
    prisma.$transaction(
        async (tx) => {
            const { ownerId, seasons } = await readScope(tx, accountId);
            const window = dayWindow(now);
            const taskWhere = {
                assignedTo: accountId,
                status: { in: TASK_OPEN_STATUSES },
                farm: { ownerId },
            };
            const [sources, protocols] = await Promise.all([
                readSources(tx, seasons.map((season) => season.id), now),
                readProtocols(tx, seasons, now),
            ]);
            const [openTaskCount, tasks, alerts, operationGroups] = await Promise.all([
                tx.task.count({ where: taskWhere }),
                tx.task.findMany({
                    where: taskWhere,
                    select: { id: true, title: true, priority: true, status: true, dueAt: true },
                    orderBy: [
                        { priority: 'desc' },
                        { dueAt: { sort: 'asc', nulls: 'last' } },
                        { id: 'asc' },
                    ],
                    take: limits.tasks,
                }),
                readAlerts(tx, seasons, now, window, sources, protocols),
                readOperations(tx, seasons, now, window, protocols),
            ]);
            return {
                date: window.date,
                serverNow: now,
                dayEndExclusive: window.end,
                summary: {
                    activeSeasonCount: seasons.length,
                    openTaskCount,
                    unresolvedActiveSeasonCaseCount: seasons.reduce(
                        (sum, s) => sum + s._count.diseaseCases,
                        0,
                    ),
                },
                alerts,
                tasks,
                operationGroups,
                seasons: seasons
                    .slice(0, limits.seasons)
                    .map((s) => presentSeason(s, sources, now)),
            };
        },
        { isolationLevel: 'RepeatableRead' },
    );

module.exports = { getOverview };
