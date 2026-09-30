const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages, PERSONNEL_ROLE } = require('../constants');

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
            isDeleted: false,
            farm: {
                isDeleted: false,
                ...(query.farmId && { id: query.farmId }),
            },
        },
    },
});

const encodeCursor = ({ assignedAt, id }) => Buffer.from(JSON.stringify({
    assignedAt: assignedAt.toISOString(),
    assignmentId: id,
})).toString('base64url');

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
            stockingDate: true, expectedEndDate: true, initialBiomassKg: true,
            pond: { select: {
                id: true, name: true, status: true,
                farm: { select: { id: true, name: true } },
            } },
        },
    },
};

const normalizeListItem = (assignment) => ({
    ...assignment.season,
    stockingDate: assignment.season.stockingDate?.toISOString().slice(0, 10) ?? null,
    expectedEndDate: assignment.season.expectedEndDate?.toISOString().slice(0, 10) ?? null,
    initialBiomassKg: assignment.season.initialBiomassKg == null
        ? null : Number(assignment.season.initialBiomassKg),
    pond: {
        id: assignment.season.pond.id,
        name: assignment.season.pond.name,
        status: assignment.season.pond.status,
    },
    farm: assignment.season.pond.farm,
    assignment: { assignedAt: assignment.assignedAt },
});

const getAssignedSeasons = async (accountId, query = {}) => {
    const { limit = 20, cursor } = query;
    const where = assignmentWhere(accountId, query);
    const countQuery = { ...query };
    delete countQuery.status;
    const allWhere = assignmentWhere(accountId, countQuery);
    const activeWhere = assignmentWhere(accountId, { ...countQuery, status: 'ACTIVE' });
    let cursorFilter = {};
    if (cursor) {
        const decoded = decodeCursor(cursor);
        const exists = await prisma.seasonPersonnelAssignment.findFirst({
            where: { ...where, id: decoded.assignmentId, assignedAt: decoded.assignedAt },
            select: { id: true },
        });
        if (!exists) throw ApiError.badRequest(messages.ASSIGNED_SEASON.INVALID_CURSOR);
        cursorFilter = { OR: [
            { assignedAt: { lt: decoded.assignedAt } },
            { assignedAt: decoded.assignedAt, id: { lt: decoded.assignmentId } },
        ] };
    }

    const [rows, totalResults, activeResults, allResults] = await Promise.all([
        prisma.seasonPersonnelAssignment.findMany({
            where: { AND: [where, cursorFilter] },
            select: listSelect,
            orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
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
                initialAvgWeightG: true, initialBiomassKg: true, initialDensityPerM2: true,
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
            } },
        },
    });
    if (!assignment) throw ApiError.notFound(messages.ASSIGNED_SEASON.NOT_FOUND);
    const { pond, personnelAssignments, ...season } = assignment.season;
    const otherAssignments = await prisma.seasonPersonnelAssignment.findMany({
        where: {
            accountId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
            seasonId: { not: seasonId },
            season: {
                pond: {
                    isDeleted: false,
                    farmId: pond.farm.id,
                    farm: { isDeleted: false },
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
    const number = (value) => value == null ? null : Number(value);
    return {
        ...season,
        stockingDate: season.stockingDate?.toISOString().slice(0, 10) ?? null,
        expectedEndDate: season.expectedEndDate?.toISOString().slice(0, 10) ?? null,
        initialQuantity: season.initialQuantity == null ? null : Number(season.initialQuantity),
        initialAvgWeightG: number(season.initialAvgWeightG),
        initialBiomassKg: number(season.initialBiomassKg),
        initialDensityPerM2: number(season.initialDensityPerM2),
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

module.exports = { getAssignedSeasons, getAssignedSeason };
