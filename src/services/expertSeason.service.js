const prisma = require('../config/prisma');
const { PERSONNEL_ROLE, SEASON_STATUS } = require('../constants');
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const localDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
});

const localDayStamp = (date) => {
    const parts = Object.fromEntries(localDate.formatToParts(date)
        .filter(({ type }) => ['year', 'month', 'day'].includes(type))
        .map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day);
};

const dayOfCulture = (season, now) => {
    if (season.status === SEASON_STATUS.PLANNING || !season.stockingDate) return null;
    const end = season.status === SEASON_STATUS.ACTIVE
        ? localDayStamp(now)
        : (season.actualEndDate?.getTime() ?? localDayStamp(season.updatedAt));
    return Math.max(0, Math.floor((end - season.stockingDate.getTime()) / MILLISECONDS_PER_DAY));
};

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

const assignedSeasonWhere = (accountId, query = {}) => ({
    AND: [
        { pond: { isDeleted: false, farm: { isDeleted: false } } },
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

const seasonSelect = {
    id: true, name: true, status: true, shrimpType: true,
    stockingDate: true, actualEndDate: true, updatedAt: true,
    pond: { select: {
        name: true,
        farm: { select: { name: true, address: true } },
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

const normalizeSeason = (season, now) => ({
    id: season.id,
    name: season.name,
    pondName: season.pond.name,
    farm: season.pond.farm,
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

const getAssignedSeasons = async (accountId, query = {}, now = new Date()) => {
    const { page = 1, limit = 10 } = query;
    const where = assignedSeasonWhere(accountId, query);
    const [totalResults, farms] = await Promise.all([
        prisma.aquacultureSeason.count({ where }),
        prisma.farm.findMany({
            where: {
                isDeleted: false,
                ponds: { some: {
                    isDeleted: false,
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

module.exports = { getAssignedSeasons };
