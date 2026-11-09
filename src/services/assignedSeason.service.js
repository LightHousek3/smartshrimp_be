const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages, PERSONNEL_ROLE, SEASON_STATUS, ASSIGNED_SEASON_LIMITS } = require('../constants');

// Prisma Decimal serializes as a string by default; the app contract expects number|null.
const number = (value) => value == null ? null : Number(value);
const dateOnly = (value) => value?.toISOString().slice(0, 10) ?? null;

/**
 * Apply the current technician assignment before optional list filters.
 * A farm filter narrows assigned seasons and never grants farm-wide access.
 */
const assignmentWhere = (accountId, query = {}) => ({
    accountId,
    role: PERSONNEL_ROLE.TECHNICIAN,
    unassignedAt: null,
    season: {
        ...(query.status && { status: query.status }),
        ...(query.search && {
            OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { pond: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
        }),
        pond: {
            farm: {
                ...(query.farmId && { id: query.farmId }),
            },
        },
    },
});

/**
 * Use assignment time plus ID as a stable descending cursor when timestamps tie.
 */
const encodeCursor = ({ assignedAt, id }) => Buffer.from(JSON.stringify({
    assignedAt: assignedAt.toISOString(),
    assignmentId: id,
})).toString('base64url');

/**
 * Treat cursors as untrusted input; malformed JSON, timestamps or UUIDs are validation errors.
 */
const decodeCursor = (cursor) => {
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const assignedAt = new Date(value.assignedAt);
        const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidV4.test(value.assignmentId) || Number.isNaN(assignedAt.getTime())) {
            throw new Error();
        }
        return { assignedAt, assignmentId: value.assignmentId };
    } catch (_) {
        throw ApiError.badRequest(messages.ASSIGNED_SEASON.INVALID_CURSOR);
    }
};

const listSelect = {
    id: true,
    assignedAt: true,
    season: {
        select: {
            id: true, name: true, status: true, shrimpType: true,
            stockingDate: true, expectedEndDate: true, initialDensityPerM2: true,
            // Show the latest recorded assessment, not a biomass-derived status.
            healthLogs: {
                where: { isVoided: false },
                select: { healthStatus: true },
                orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
                take: 1,
            },
            pond: { select: {
                id: true, name: true, status: true,
                farm: { select: { id: true, name: true } },
            } },
        },
    },
};

const normalizeListItem = ({ season: { healthLogs = [], pond, ...season }, assignedAt }) => ({
    ...season,
    stockingDate: dateOnly(season.stockingDate),
    expectedEndDate: dateOnly(season.expectedEndDate),
    initialDensityPerM2: number(season.initialDensityPerM2),
    currentHealthStatus: healthLogs[0]?.healthStatus ?? null,
    pond: {
        id: pond.id,
        name: pond.name,
        status: pond.status,
    },
    farm: pond.farm,
    assignment: { assignedAt },
});

/**
 * List seasons with a current technician assignment using cursor pagination.
 * Counts include active seasons and all matching assignments regardless of
 * the requested season status. Access follows the current assignment.
 * Resolve the supplied cursor inside that scope before applying its time/ID boundary.
 */
const getAssignedSeasons = async (accountId, query = {}) => {
    const { limit = ASSIGNED_SEASON_LIMITS.DEFAULT_PAGE_SIZE, cursor } = query;
    const where = assignmentWhere(accountId, query);
    const countQuery = { ...query };
    delete countQuery.status;
    const allWhere = assignmentWhere(accountId, countQuery);
    const activeWhere = assignmentWhere(accountId, { ...countQuery, status: SEASON_STATUS.ACTIVE });
    let pagination = {};
    if (cursor) {
        const decoded = decodeCursor(cursor);
        const assignment = await prisma.seasonPersonnelAssignment.findFirst({
            where: { ...where, id: decoded.assignmentId },
            select: { id: true, assignedAt: true },
        });
        // Validate the existing wire timestamp at JavaScript precision only.
        // Prisma's ID cursor resolves the real ordering values inside the DB,
        // preserving microseconds and the ID tie-break without rounding SQL filters.
        if (!assignment || assignment.assignedAt.getTime() !== decoded.assignedAt.getTime()) {
            throw ApiError.badRequest(messages.ASSIGNED_SEASON.INVALID_CURSOR);
        }
        pagination = { cursor: { id: assignment.id }, skip: 1 };
    }

    const [rows, totalResults, activeResults, allResults] = await Promise.all([
        prisma.seasonPersonnelAssignment.findMany({
            where,
            select: listSelect,
            orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...pagination,
        }),
        prisma.seasonPersonnelAssignment.count({ where }),
        prisma.seasonPersonnelAssignment.count({ where: activeWhere }),
        prisma.seasonPersonnelAssignment.count({ where: allWhere }),
    ]);
    const hasNextPage = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
        seasons: page.map(normalizeListItem),
        meta: {
            limit, totalResults, activeResults, allResults, hasNextPage,
            nextCursor: hasNextPage ? encodeCursor(page[page.length - 1]) : null,
        },
    };
};

/**
 * Get details of a season currently assigned to the technician.
 * Include current personnel and other currently assigned seasons in the same farm.
 * Biomass comes from the latest non-voided health log, even if its estimate is null;
 * this display value does not establish freshness or authorize an operation dose.
 */
const getAssignedSeason = async (accountId, seasonId) => {
    const assignment = await prisma.seasonPersonnelAssignment.findFirst({
        where: {
            accountId, seasonId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
        },
        select: {
            assignedAt: true,
            season: { select: {
                id: true, name: true, status: true, shrimpType: true,
                stockingDate: true, expectedEndDate: true, initialQuantity: true,
                initialDensityPerM2: true,
                pond: { select: {
                    id: true, name: true, type: true, status: true,
                    areaM2: true, depthM: true, volumeM3: true,
                    farm: { select: { id: true, name: true, address: true } },
                } },
                personnelAssignments: {
                    where: { unassignedAt: null },
                    select: {
                        id: true, role: true, assignedAt: true,
                        account: { select: { id: true, fullName: true, avatarUrl: true } },
                    },
                    orderBy: [{ role: 'asc' }, { assignedAt: 'desc' }],
                },
                healthLogs: {
                    where: { isVoided: false },
                    select: { estimatedBiomassKg: true },
                    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
                    take: 1,
                },
            } },
        },
    });
    if (!assignment) throw ApiError.notFound(messages.ASSIGNED_SEASON.NOT_FOUND);
    const {
        pond,
        personnelAssignments,
        healthLogs,
        ...season
    } = assignment.season;
    const otherAssignments = await prisma.seasonPersonnelAssignment.findMany({
        where: {
            accountId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
            seasonId: { not: seasonId },
            season: {
                pond: {
                    farmId: pond.farm.id,
                },
            },
        },
        select: {
            assignedAt: true,
            season: {
                select: {
                    id: true, name: true, status: true,
                    pond: {
                        select: {
                            id: true, name: true, status: true,
                            areaM2: true, volumeM3: true,
                        },
                    },
                },
            },
        },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    });
    return {
        ...season,
        stockingDate: dateOnly(season.stockingDate),
        expectedEndDate: dateOnly(season.expectedEndDate),
        initialQuantity: season.initialQuantity == null ? null : Number(season.initialQuantity),
        initialDensityPerM2: number(season.initialDensityPerM2),
        currentBiomassKg: number(healthLogs[0]?.estimatedBiomassKg),
        pond: {
            id: pond.id, name: pond.name, type: pond.type, status: pond.status,
            areaM2: number(pond.areaM2), depthM: number(pond.depthM), volumeM3: number(pond.volumeM3),
        },
        farm: { id: pond.farm.id, name: pond.farm.name, address: pond.farm.address },
        otherAssignedSeasons: otherAssignments.map(({ assignedAt, season: otherSeason }) => ({
            id: otherSeason.id,
            name: otherSeason.name,
            status: otherSeason.status,
            assignedAt,
            pond: {
                ...otherSeason.pond,
                areaM2: number(otherSeason.pond.areaM2),
                volumeM3: number(otherSeason.pond.volumeM3),
            },
        })),
        personnel: personnelAssignments.map((item) => ({
            id: item.id, role: item.role, assignedAt: item.assignedAt, account: item.account,
        })),
        assignment: { assignedAt: assignment.assignedAt },
    };
};

/**
 * Return distinct farm choices across all current technician assignments.
 * Farm-level querying avoids duplicates and never depends on list pagination,
 * search text, season status or a farm's operational status.
 */
const getAssignedSeasonFarms = async (accountId) => prisma.farm.findMany({
    where: {
        ponds: { some: {
            seasons: { some: {
                personnelAssignments: { some: {
                    accountId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null,
                } },
            } },
        } },
    },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
});

module.exports = { getAssignedSeasons, getAssignedSeason, getAssignedSeasonFarms };
