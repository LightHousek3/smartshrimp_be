const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_ROLE } = require('../constants');

const STAFF_ROLES = [ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT];
const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];

const PERSONNEL_SELECT = {
    id: true,
    email: true,
    phone: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    createdAt: true,
    activatedAt: true,
    lastLoginAt: true,
    updatedAt: true,
};

const buildWhere = (ownerId, { role, status, search }) => ({
    managedByOwnerId: ownerId,
    role: role || { in: STAFF_ROLES },
    ...(status && { status }),
    ...(search && {
        OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { fullName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
        ],
    }),
});

const buildOrderBy = (sortBy, sortOrder) => {
    const direction = sortOrder === 'desc' ? 'desc' : 'asc';
    if (sortBy === 'createdAt') return [{ createdAt: direction }, { id: direction }];
    return [
        { fullName: { sort: direction, nulls: 'last' } },
        { email: direction },
        { id: direction },
    ];
};

const attachAssignmentCounts = async (accounts) => {
    if (accounts.length === 0) return [];

    const assignments = await prisma.seasonPersonnelAssignment.findMany({
        where: {
            accountId: { in: accounts.map((account) => account.id) },
            unassignedAt: null,
        },
        select: { accountId: true, seasonId: true },
    });

    if (assignments.length === 0) {
        return accounts.map((account) => ({ ...account, currentSeasonAssignments: 0 }));
    }

    const seasons = await prisma.aquacultureSeason.findMany({
        where: {
            id: { in: [...new Set(assignments.map((assignment) => assignment.seasonId))] },
            status: { in: OPEN_SEASON_STATUSES },
        },
        select: { id: true },
    });
    const openSeasonIds = new Set(seasons.map((season) => season.id));
    const counts = new Map();
    for (const assignment of assignments) {
        if (!openSeasonIds.has(assignment.seasonId)) continue;
        const seasonIds = counts.get(assignment.accountId) || new Set();
        seasonIds.add(assignment.seasonId);
        counts.set(assignment.accountId, seasonIds);
    }

    return accounts.map((account) => ({
        ...account,
        currentSeasonAssignments: counts.get(account.id)?.size || 0,
    }));
};

const getListPersonnel = async (ownerId, {
    cursor,
    limit = 20,
    role,
    status,
    search,
    sortBy = 'identity',
    sortOrder = 'asc',
} = {}) => {
    const where = buildWhere(ownerId, { role, status, search });
    if (cursor) {
        const cursorAccount = await prisma.account.findFirst({
            where: { ...where, id: cursor },
            select: { id: true },
        });
        if (!cursorAccount) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.PERSONNEL.INVALID_CURSOR);
        }
    }

    const [rows, totalResults] = await Promise.all([
        prisma.account.findMany({
            where,
            select: PERSONNEL_SELECT,
            orderBy: buildOrderBy(sortBy, sortOrder),
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        }),
        prisma.account.count({ where }),
    ]);
    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    return {
        personnel: await attachAssignmentCounts(pageRows),
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null,
        },
    };
};

const getPersonnelById = async (ownerId, personnelId) => {
    const account = await prisma.account.findFirst({
        where: {
            id: personnelId,
            managedByOwnerId: ownerId,
            role: { in: STAFF_ROLES },
        },
        select: PERSONNEL_SELECT,
    });
    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.PERSONNEL.NOT_FOUND);
    }
    const [personnel] = await attachAssignmentCounts([account]);
    return personnel;
};

module.exports = { getListPersonnel, getPersonnelById };
