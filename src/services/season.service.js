const prisma = require('../config/prisma');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const { dataAccess } = require('../plugins');
const {
    httpStatus,
    messages,
    ACCOUNT_STATUS,
    NOTIFICATION_TYPE,
    PERSONNEL_ROLE,
    SEASON_STATUS,
} = require('../constants');

const MAX_INITIAL_DENSITY_PER_M2 = 9999999999.99;
const CANCELLABLE_STATUSES = [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE];
const API_TIMESTAMP_PRECISION_MS = 1;
const ASSIGNABLE_STATUSES = [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE];
const OPEN_TASK_STATUSES = ['PENDING', 'IN_PROGRESS'];

const SEASON_BASE_SELECT = {
    id: true,
    pondId: true,
    name: true,
    shrimpType: true,
    stockingDate: true,
    expectedEndDate: true,
    actualEndDate: true,
    initialQuantity: true,
    initialDensityPerM2: true,
    status: true,
    cancellationReason: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
};

const POND_SUMMARY_SELECT = {
    id: true,
    farmId: true,
    name: true,
    areaM2: true,
    type: true,
    status: true,
    isDeleted: true,
    deletedAt: true,
    farm: {
        select: {
            id: true,
            name: true,
            isDeleted: true,
            deletedAt: true,
        },
    },
};

const SEASON_LIST_SELECT = {
    ...SEASON_BASE_SELECT,
    pond: { select: POND_SUMMARY_SELECT },
};

const SEASON_DETAIL_SELECT = {
    ...SEASON_LIST_SELECT,
    personnelAssignments: {
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
            role: true,
            assignedAt: true,
            unassignedAt: true,
            account: {
                select: {
                    id: true,
                    email: true,
                    fullName: true,
                    phone: true,
                    status: true,
                },
            },
        },
    },
};

const ASSIGNMENT_SELECT = {
    id: true,
    seasonId: true,
    role: true,
    assignedAt: true,
    account: {
        select: {
            id: true,
            email: true,
            fullName: true,
            phone: true,
            status: true,
        },
    },
};

const vietnamDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const toDateOnly = (value) => (value ? value.toISOString().slice(0, 10) : null);
const parseDateOnly = (value) => (value == null ? null : new Date(`${value}T00:00:00.000Z`));

// PostgreSQL keeps microseconds, but JavaScript dates and JSON only keep
// milliseconds. Match the millisecond represented by the API timestamp so a
// current record is not mistaken for a concurrent update.
const updatedAtApiWindow = (value) => {
    const start = value instanceof Date ? value : new Date(value);
    return {
        gte: start,
        lt: new Date(start.getTime() + API_TIMESTAMP_PRECISION_MS),
    };
};

const dayOfCulture = (stockingDate) => {
    if (!stockingDate) return null;
    const todayParts = Object.fromEntries(
        vietnamDateFormatter
            .formatToParts(new Date())
            .filter(({ type }) => type !== 'literal')
            .map(({ type, value }) => [type, Number(value)]),
    );
    const utcToday = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
    const utcStockingDate = Date.UTC(
        stockingDate.getUTCFullYear(),
        stockingDate.getUTCMonth(),
        stockingDate.getUTCDate(),
    );
    const days = Math.floor((utcToday - utcStockingDate) / 86400000) + 1;
    return days > 0 ? days : null;
};

const normalizePondSummary = (pond) => ({
    ...pond,
    areaM2: pond.areaM2 == null ? null : Number(pond.areaM2),
});

const normalizeSeasonBase = (season) => ({
    ...season,
    stockingDate: toDateOnly(season.stockingDate),
    expectedEndDate: toDateOnly(season.expectedEndDate),
    actualEndDate: toDateOnly(season.actualEndDate),
    initialQuantity: season.initialQuantity == null ? null : season.initialQuantity.toString(),
    initialDensityPerM2:
        season.initialDensityPerM2 == null ? null : Number(season.initialDensityPerM2),
    dayOfCulture:
        season.status === SEASON_STATUS.ACTIVE ? dayOfCulture(season.stockingDate) : null,
});

const normalizeSeasonSummary = ({ pond, ...season }) => ({
    ...normalizeSeasonBase(season),
    pond: normalizePondSummary(pond),
});

const getActiveAssignment = (assignments, role) =>
    assignments.find(
        (assignment) =>
            assignment.role === role
            && assignment.unassignedAt == null
            && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    ) || null;

const getLatestAssignment = (assignments, role) =>
    assignments.find((assignment) => assignment.role === role) || null;

const buildActivationEligibility = (season) => {
    const missingConditions = [];
    const activeTechnicians = season.personnelAssignments.filter(
        (assignment) =>
            assignment.role === PERSONNEL_ROLE.TECHNICIAN
            && assignment.unassignedAt == null
            && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    );
    const activeExperts = season.personnelAssignments.filter(
        (assignment) =>
            assignment.role === PERSONNEL_ROLE.EXPERT
            && assignment.unassignedAt == null
            && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    );

    if (season.status !== SEASON_STATUS.PLANNING) missingConditions.push('SEASON_NOT_PLANNING');
    if (season.pond.farm.isDeleted) missingConditions.push('FARM_ARCHIVED');
    if (season.pond.isDeleted) missingConditions.push('POND_ARCHIVED');
    if (season.pond.status !== 'AVAILABLE') missingConditions.push('POND_NOT_AVAILABLE');
    if (season.pond.type !== 'AQUACULTURE') missingConditions.push('POND_NOT_AQUACULTURE');
    if (!season.stockingDate) missingConditions.push('STOCKING_DATE_REQUIRED');
    if (season.initialQuantity == null) missingConditions.push('INITIAL_QUANTITY_REQUIRED');
    if (season.initialDensityPerM2 == null) missingConditions.push('INITIAL_DENSITY_REQUIRED');
    if (activeTechnicians.length !== 1) missingConditions.push('ACTIVE_TECHNICIAN_REQUIRED');
    if (activeExperts.length !== 1) missingConditions.push('ACTIVE_EXPERT_REQUIRED');
    if (season.protocols.length !== 1) {
        missingConditions.push('APPROVED_PRODUCTION_PROTOCOL_REQUIRED');
    }

    return {
        canActivate: missingConditions.length === 0,
        missingConditions,
    };
};

const normalizeSeasonDetail = ({
    personnelAssignments,
    protocols = [],
    pond,
    ...season
}) => {
    const activationEligibility = buildActivationEligibility({
        ...season,
        pond,
        personnelAssignments,
        protocols,
    });
    const technician = getActiveAssignment(personnelAssignments, PERSONNEL_ROLE.TECHNICIAN);
    const expert = getActiveAssignment(personnelAssignments, PERSONNEL_ROLE.EXPERT);

    return {
        ...normalizeSeasonBase(season),
        pond: normalizePondSummary(pond),
        personnel: {
            technician,
            expert,
        },
        lastAssignedPersonnel: {
            technician: getLatestAssignment(
                personnelAssignments,
                PERSONNEL_ROLE.TECHNICIAN,
            ),
            expert: getLatestAssignment(personnelAssignments, PERSONNEL_ROLE.EXPERT),
        },
        approvedProductionProtocol: protocols[0] || null,
        activationEligibility,
        availableActions: {
            update: season.status === SEASON_STATUS.PLANNING,
            activate: activationEligibility.canActivate,
            cancel: CANCELLABLE_STATUSES.includes(season.status),
        },
    };
};

const buildSeasonWhere = (ownerId, { farmId, pondId, status, search } = {}) => ({
    pond: dataAccess.notDeleted({
        ...(pondId && { id: pondId }),
        farm: dataAccess.notDeleted({
            ownerId,
            ...(farmId && { id: farmId }),
        }),
    }),
    ...(status && { status }),
    ...(search && { name: { contains: search, mode: 'insensitive' } }),
});

const findOwnedSeason = async (client, seasonId, ownerId, select = SEASON_DETAIL_SELECT) => {
    const season = await client.aquacultureSeason.findFirst({
        where: {
            id: seasonId,
            pond: dataAccess.notDeleted({
                farm: dataAccess.notDeleted({ ownerId }),
            }),
        },
        select,
    });
    if (!season) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.SEASON.NOT_FOUND);
    }
    return season;
};

const dependencyTableExists = async (client, tableName) => {
    const [result] = await client.$queryRawUnsafe(
        'SELECT to_regclass($1) IS NOT NULL AS "exists"',
        `public.${tableName}`,
    );
    return result?.exists === true;
};

const getApprovedProductionProtocols = async (client, seasonId) => {
    if (!await dependencyTableExists(client, 'protocols')) return [];
    return client.$queryRawUnsafe(
        `SELECT id,
                title,
                version_no AS "versionNo",
                upper(status::text) AS status,
                reviewed_at AS "reviewedAt"
           FROM protocols
          WHERE season_id = $1::uuid
            AND protocol_type = 'production'
            AND status = 'approved'
          ORDER BY version_no DESC
          LIMIT 2`,
        seasonId,
    );
};

const findOwnedSeasonDetail = async (client, seasonId, ownerId) => {
    const season = await findOwnedSeason(client, seasonId, ownerId);
    const protocols = await getApprovedProductionProtocols(client, seasonId);
    return { ...season, protocols };
};

const getSeasons = async (ownerId, query = {}) => {
    const { cursor, limit = 20 } = query;
    const where = buildSeasonWhere(ownerId, query);

    if (cursor) {
        const cursorSeason = await prisma.aquacultureSeason.findFirst({
            where: { ...where, id: cursor },
            select: { id: true },
        });
        if (!cursorSeason) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.INVALID_CURSOR);
        }
    }

    const [rows, totalResults] = await Promise.all([
        prisma.aquacultureSeason.findMany({
            where: cursor ? { ...where, id: { not: cursor } } : where,
            select: SEASON_LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor } }),
        }),
        prisma.aquacultureSeason.count({ where }),
    ]);

    const hasNextPage = rows.length > limit;
    const seasons = (hasNextPage ? rows.slice(0, limit) : rows).map(normalizeSeasonSummary);
    return {
        seasons,
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? seasons[seasons.length - 1].id : null,
        },
    };
};

const getSeason = async (seasonId, ownerId) => {
    const season = await findOwnedSeasonDetail(prisma, seasonId, ownerId);
    return normalizeSeasonDetail(season);
};

const calculateInitialDensity = (initialQuantity, areaM2) => {
    if (initialQuantity == null || areaM2 == null) return null;

    const density = Math.round((Number(initialQuantity) / Number(areaM2)) * 100) / 100;
    if (density <= 0 || density > MAX_INITIAL_DENSITY_PER_M2) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.DERIVED_VALUE_OUT_OF_RANGE);
    }
    return density;
};

const assertDateRange = (stockingDate, expectedEndDate) => {
    if (stockingDate && expectedEndDate && expectedEndDate < stockingDate) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.INVALID_DATE_RANGE);
    }
};

const buildCreateData = (seasonData, ownerId, areaM2) => {
    const stockingDate = parseDateOnly(seasonData.stockingDate);
    const expectedEndDate = parseDateOnly(seasonData.expectedEndDate);
    assertDateRange(stockingDate, expectedEndDate);
    return {
        pondId: seasonData.pondId,
        name: seasonData.name,
        shrimpType: seasonData.shrimpType,
        stockingDate,
        expectedEndDate,
        initialQuantity:
            seasonData.initialQuantity == null ? null : BigInt(seasonData.initialQuantity),
        initialDensityPerM2: calculateInitialDensity(seasonData.initialQuantity, areaM2),
        status: SEASON_STATUS.PLANNING,
        createdBy: ownerId,
    };
};

const assertEligiblePond = (pond) => {
    if (pond.farm.isDeleted) {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.FARM_ARCHIVED);
    }
    if (pond.isDeleted) {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.POND_ARCHIVED);
    }
    if (pond.status !== 'AVAILABLE') {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.POND_NOT_AVAILABLE);
    }
    if (pond.type !== 'AQUACULTURE') {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.POND_NOT_AQUACULTURE);
    }
};

const mapWriteError = (error) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002') {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.OPEN_SEASON_EXISTS);
    }
    if (error.code === 'P2003') {
        throw new ApiError(httpStatus.NOT_FOUND, messages.SEASON.POND_NOT_FOUND);
    }
    if (error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
    }
    throw error;
};

const createSeason = async (seasonData, ownerId) => {
    try {
        const season = await prisma.$transaction(async (transaction) => {
            const pond = await transaction.pond.findFirst({
                where: dataAccess.notDeleted({
                    id: seasonData.pondId,
                    farm: dataAccess.notDeleted({ ownerId }),
                }),
                select: {
                    id: true,
                    areaM2: true,
                    type: true,
                    status: true,
                    isDeleted: true,
                    deletedAt: true,
                    farm: { select: { isDeleted: true, deletedAt: true } },
                },
            });
            if (!pond) {
                throw new ApiError(httpStatus.NOT_FOUND, messages.SEASON.POND_NOT_FOUND);
            }
            assertEligiblePond(pond);

            const openSeasonCount = await transaction.aquacultureSeason.count({
                where: {
                    pondId: pond.id,
                    status: { in: [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE] },
                },
            });
            if (openSeasonCount > 0) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.OPEN_SEASON_EXISTS);
            }

            const created = await transaction.aquacultureSeason.create({
                data: buildCreateData(seasonData, ownerId, pond.areaM2),
                select: { id: true },
            });
            return findOwnedSeasonDetail(transaction, created.id, ownerId);
        }, { isolationLevel: 'Serializable' });

        return normalizeSeasonDetail(season);
    } catch (error) {
        return mapWriteError(error);
    }
};

const assignmentRoleLabel = (role) => (
    role === PERSONNEL_ROLE.TECHNICIAN ? 'Kỹ thuật viên' : 'Chuyên gia thủy sản'
);

const requireEligiblePersonnel = async (client, accountId, role, ownerId) => {
    const account = await client.account.findFirst({
        where: {
            id: accountId,
            managedByOwnerId: ownerId,
            role,
            status: ACCOUNT_STATUS.ACTIVE,
        },
        select: { id: true },
    });
    if (!account) {
        throw new ApiError(
            httpStatus.NOT_FOUND,
            messages.SEASON.ASSIGNMENT_PERSONNEL_NOT_ELIGIBLE,
        );
    }
    return account;
};

const mapPersonnelAssignmentWriteError = (error, conflictMessage) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, conflictMessage);
    }
    throw error;
};

const requireAssignableSeason = async (client, seasonId, ownerId) => {
    const season = await findOwnedSeason(client, seasonId, ownerId, {
        id: true,
        name: true,
        status: true,
    });
    if (!ASSIGNABLE_STATUSES.includes(season.status)) {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.ASSIGNMENT_NOT_ALLOWED);
    }
    return season;
};

const assignPersonnel = async (seasonId, { accountId, role }, ownerId) => {
    try {
        const result = await prisma.$transaction(async (transaction) => {
            const season = await requireAssignableSeason(transaction, seasonId, ownerId);
            await requireEligiblePersonnel(transaction, accountId, role, ownerId);

            const currentAssignments = await transaction.seasonPersonnelAssignment.findMany({
                where: {
                    seasonId,
                    unassignedAt: null,
                    OR: [{ role }, { accountId }],
                },
                select: { role: true, accountId: true },
            });
            if (currentAssignments.some((assignment) => assignment.role === role)) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.ASSIGNMENT_ROLE_OCCUPIED,
                );
            }
            if (currentAssignments.some((assignment) => assignment.accountId === accountId)) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.ASSIGNMENT_PERSONNEL_ALREADY_ASSIGNED,
                );
            }

            const assignment = await transaction.seasonPersonnelAssignment.create({
                data: {
                    seasonId,
                    role,
                    accountId,
                    assignedBy: ownerId,
                },
                select: ASSIGNMENT_SELECT,
            });
            const notification = await transaction.notification.create({
                data: {
                    accountId,
                    title: 'Bạn được phân công vào vụ nuôi',
                    content:
                        `Bạn đã được phân công làm ${assignmentRoleLabel(role)} `
                        + `cho vụ nuôi ${season.name}.`,
                    type: NOTIFICATION_TYPE.SEASON_ASSIGNMENT_CREATED,
                    referenceType: 'aquaculture_season',
                    referenceId: seasonId,
                },
                select: { id: true },
            });

            return { assignment, notificationId: notification.id };
        }, { isolationLevel: 'Serializable' });

        emitNotification(accountId, 'notification:new', {
            id: result.notificationId,
            referenceId: seasonId,
        });
        return result.assignment;
    } catch (error) {
        return mapPersonnelAssignmentWriteError(
            error,
            messages.SEASON.ASSIGNMENT_CONFLICT,
        );
    }
};

const transferReplacementWork = async (
    client,
    { seasonId, role, previousAccountId, replacementAccountId, replacedAt },
) => {
    if (role === PERSONNEL_ROLE.TECHNICIAN) {
        const result = await client.task.updateMany({
            where: {
                seasonId,
                assignedTo: previousAccountId,
                status: { in: OPEN_TASK_STATUSES },
            },
            data: {
                assignedTo: replacementAccountId,
                updatedAt: replacedAt,
            },
        });
        return { transferredTaskCount: result.count, transferredDiseaseCaseCount: 0 };
    }

    const transferredDiseaseCaseCount = await client.$executeRawUnsafe(
        `UPDATE disease_cases
            SET expert_id = $1::uuid,
                updated_at = $2
          WHERE season_id = $3::uuid
            AND expert_id = $4::uuid
            AND status <> 'resolved'`,
        replacementAccountId,
        replacedAt,
        seasonId,
        previousAccountId,
    );
    return { transferredTaskCount: 0, transferredDiseaseCaseCount };
};

const replacePersonnel = async (
    seasonId,
    role,
    { accountId, expectedAssignmentId, reason },
    ownerId,
) => {
    try {
        const result = await prisma.$transaction(async (transaction) => {
            const season = await requireAssignableSeason(transaction, seasonId, ownerId);
            const currentAssignment = await transaction.seasonPersonnelAssignment.findFirst({
                where: {
                    id: expectedAssignmentId,
                    seasonId,
                    role,
                    unassignedAt: null,
                },
                select: { id: true, accountId: true },
            });
            if (!currentAssignment) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.REPLACEMENT_CURRENT_ASSIGNMENT_CHANGED,
                );
            }
            if (currentAssignment.accountId === accountId) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.REPLACEMENT_SAME_PERSONNEL,
                );
            }

            await requireEligiblePersonnel(transaction, accountId, role, ownerId);
            const existingAssignment = await transaction.seasonPersonnelAssignment.findFirst({
                where: { seasonId, accountId, unassignedAt: null },
                select: { id: true },
            });
            if (existingAssignment) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.ASSIGNMENT_PERSONNEL_ALREADY_ASSIGNED,
                );
            }

            const replacedAt = new Date();
            const closeResult = await transaction.seasonPersonnelAssignment.updateMany({
                where: {
                    id: currentAssignment.id,
                    seasonId,
                    role,
                    unassignedAt: null,
                    replacedByAssignmentId: null,
                },
                data: {
                    unassignedAt: replacedAt,
                    unassignedBy: ownerId,
                    replacementReason: reason,
                },
            });
            if (closeResult.count !== 1) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.REPLACEMENT_CURRENT_ASSIGNMENT_CHANGED,
                );
            }

            const assignment = await transaction.seasonPersonnelAssignment.create({
                data: {
                    seasonId,
                    role,
                    accountId,
                    assignedBy: ownerId,
                },
                select: ASSIGNMENT_SELECT,
            });
            const linkResult = await transaction.seasonPersonnelAssignment.updateMany({
                where: {
                    id: currentAssignment.id,
                    replacedByAssignmentId: null,
                },
                data: { replacedByAssignmentId: assignment.id },
            });
            if (linkResult.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.REPLACEMENT_CONFLICT);
            }

            const transferResult = await transferReplacementWork(transaction, {
                seasonId,
                role,
                previousAccountId: currentAssignment.accountId,
                replacementAccountId: accountId,
                replacedAt,
            });
            await transaction.notification.createMany({
                data: [
                    {
                        accountId: currentAssignment.accountId,
                        title: 'Phân công vụ nuôi đã được thay đổi',
                        content:
                            `Bạn không còn phụ trách vai trò ${assignmentRoleLabel(role)} `
                            + `cho vụ nuôi ${season.name}. Lý do: ${reason}`,
                        type: NOTIFICATION_TYPE.SEASON_ASSIGNMENT_REPLACED,
                        referenceType: 'aquaculture_season',
                        referenceId: seasonId,
                    },
                    {
                        accountId,
                        title: 'Bạn được phân công thay thế nhân sự',
                        content:
                            `Bạn đã được phân công làm ${assignmentRoleLabel(role)} `
                            + `cho vụ nuôi ${season.name}.`,
                        type: NOTIFICATION_TYPE.SEASON_ASSIGNMENT_REPLACED,
                        referenceType: 'aquaculture_season',
                        referenceId: seasonId,
                    },
                ],
            });

            return {
                assignment,
                replacedAssignment: {
                    id: currentAssignment.id,
                    role,
                    accountId: currentAssignment.accountId,
                    unassignedAt: replacedAt,
                    unassignedBy: ownerId,
                    replacementReason: reason,
                    replacedByAssignmentId: assignment.id,
                },
                ...transferResult,
                notificationAccountIds: [currentAssignment.accountId, accountId],
            };
        }, { isolationLevel: 'Serializable' });

        result.notificationAccountIds.forEach((notificationAccountId) => {
            emitNotification(notificationAccountId, 'notification:new', {
                referenceId: seasonId,
            });
        });
        return {
            assignment: result.assignment,
            replacedAssignment: result.replacedAssignment,
            transferredTaskCount: result.transferredTaskCount,
            transferredDiseaseCaseCount: result.transferredDiseaseCaseCount,
        };
    } catch (error) {
        return mapPersonnelAssignmentWriteError(
            error,
            messages.SEASON.REPLACEMENT_CONFLICT,
        );
    }
};

const buildUpdateData = (seasonData, current) => {
    const data = {};
    for (const key of ['name', 'shrimpType']) {
        if (Object.hasOwn(seasonData, key)) data[key] = seasonData[key];
    }
    if (Object.hasOwn(seasonData, 'stockingDate')) {
        data.stockingDate = parseDateOnly(seasonData.stockingDate);
    }
    if (Object.hasOwn(seasonData, 'expectedEndDate')) {
        data.expectedEndDate = parseDateOnly(seasonData.expectedEndDate);
    }
    if (Object.hasOwn(seasonData, 'initialQuantity')) {
        data.initialQuantity = seasonData.initialQuantity == null
            ? null
            : BigInt(seasonData.initialQuantity);
    }
    const nextStockingDate = Object.hasOwn(data, 'stockingDate')
        ? data.stockingDate
        : current.stockingDate;
    const nextExpectedEndDate = Object.hasOwn(data, 'expectedEndDate')
        ? data.expectedEndDate
        : current.expectedEndDate;
    assertDateRange(nextStockingDate, nextExpectedEndDate);

    if (Object.hasOwn(seasonData, 'initialQuantity')) {
        data.initialDensityPerM2 = calculateInitialDensity(
            data.initialQuantity,
            current.pond.areaM2,
        );
    }

    return data;
};

const updateSeason = async (seasonId, seasonData, ownerId) => {
    const { expectedUpdatedAt, ...editableData } = seasonData;
    try {
        const season = await prisma.$transaction(async (transaction) => {
            const current = await findOwnedSeason(transaction, seasonId, ownerId, SEASON_LIST_SELECT);
            if (current.status !== SEASON_STATUS.PLANNING) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.PLANNING_UPDATE_ONLY);
            }

            const result = await transaction.aquacultureSeason.updateMany({
                where: {
                    id: seasonId,
                    status: SEASON_STATUS.PLANNING,
                    updatedAt: updatedAtApiWindow(expectedUpdatedAt),
                },
                data: buildUpdateData(editableData, current),
            });
            if (result.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
            }
            return findOwnedSeasonDetail(transaction, seasonId, ownerId);
        }, { isolationLevel: 'Serializable' });

        return normalizeSeasonDetail(season);
    } catch (error) {
        return mapWriteError(error);
    }
};

const buildStatusNotifications = (season, content) => {
    const accountIds = [...new Set(
        season.personnelAssignments
            .filter(
                (assignment) =>
                    assignment.unassignedAt == null
                    && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
            )
            .map((assignment) => assignment.account.id),
    )];
    return {
        accountIds,
        data: accountIds.map((accountId) => ({
            accountId,
            title: 'Trạng thái vụ nuôi đã thay đổi',
            content,
            type: NOTIFICATION_TYPE.SEASON_STATUS_CHANGED,
            referenceType: 'aquaculture_season',
            referenceId: season.id,
        })),
    };
};

const emitStatusNotifications = (accountIds, seasonId) => {
    accountIds.forEach((accountId) => {
        emitNotification(accountId, 'notification:new', { referenceId: seasonId });
    });
};

const cancelPlannedOperationSchedules = async (
    client,
    seasonId,
    reason,
    ownerId,
    cancelledAt,
) => {
    if (!await dependencyTableExists(client, 'operation_schedules')) return 0;
    return client.$executeRawUnsafe(
        `UPDATE operation_schedules
            SET status = 'cancelled',
                cancellation_type = 'season_cancelled',
                cancellation_reason = $1,
                cancelled_by = $2::uuid,
                cancelled_at = $3,
                updated_at = NOW()
          WHERE season_id = $4::uuid
            AND status = 'planned'`,
        reason,
        ownerId,
        cancelledAt,
        seasonId,
    );
};

const unassignCurrentSeasonPersonnel = async (
    client,
    seasonId,
    ownerId,
    unassignedAt,
) => client.seasonPersonnelAssignment.updateMany({
    where: {
        seasonId,
        unassignedAt: null,
    },
    data: {
        unassignedAt,
        unassignedBy: ownerId,
    },
});

const activateSeason = async (seasonId, { expectedUpdatedAt }, ownerId) => {
    try {
        const result = await prisma.$transaction(async (transaction) => {
            const current = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
            if (current.status !== SEASON_STATUS.PLANNING) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.ACTIVATION_REQUIRES_PLANNING,
                );
            }
            const eligibility = buildActivationEligibility(current);
            if (!eligibility.canActivate) {
                throw new ApiError(
                    httpStatus.CONFLICT,
                    messages.SEASON.ACTIVATION_CONDITIONS_NOT_MET,
                );
            }

            const update = await transaction.aquacultureSeason.updateMany({
                where: {
                    id: seasonId,
                    status: SEASON_STATUS.PLANNING,
                    updatedAt: updatedAtApiWindow(expectedUpdatedAt),
                },
                data: { status: SEASON_STATUS.ACTIVE },
            });
            if (update.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
            }

            const notifications = buildStatusNotifications(
                current,
                `Vụ nuôi ${current.name} đã được kích hoạt.`,
            );
            if (notifications.data.length > 0) {
                await transaction.notification.createMany({ data: notifications.data });
            }
            const season = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
            return { season, notificationAccountIds: notifications.accountIds };
        }, { isolationLevel: 'Serializable' });

        emitStatusNotifications(result.notificationAccountIds, seasonId);
        return normalizeSeasonDetail(result.season);
    } catch (error) {
        return mapWriteError(error);
    }
};

const cancelSeason = async (seasonId, { reason, expectedUpdatedAt }, ownerId) => {
    try {
        const result = await prisma.$transaction(async (transaction) => {
            const current = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
            if (!CANCELLABLE_STATUSES.includes(current.status)) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CANCELLATION_NOT_ALLOWED);
            }

            const cancelledAt = new Date();
            const update = await transaction.aquacultureSeason.updateMany({
                where: {
                    id: seasonId,
                    status: current.status,
                    updatedAt: updatedAtApiWindow(expectedUpdatedAt),
                },
                data: {
                    status: SEASON_STATUS.CANCELLED,
                    cancellationReason: reason,
                },
            });
            if (update.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
            }

            await unassignCurrentSeasonPersonnel(
                transaction,
                seasonId,
                ownerId,
                cancelledAt,
            );
            const cancelledScheduleCount = await cancelPlannedOperationSchedules(
                transaction,
                seasonId,
                reason,
                ownerId,
                cancelledAt,
            );
            const notifications = buildStatusNotifications(
                current,
                `Vụ nuôi ${current.name} đã bị hủy. Lý do: ${reason}`,
            );
            if (notifications.data.length > 0) {
                await transaction.notification.createMany({ data: notifications.data });
            }
            const season = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
            return {
                season,
                cancelledScheduleCount,
                notificationAccountIds: notifications.accountIds,
            };
        }, { isolationLevel: 'Serializable' });

        emitStatusNotifications(result.notificationAccountIds, seasonId);
        return {
            season: normalizeSeasonDetail(result.season),
            cancelledScheduleCount: result.cancelledScheduleCount,
        };
    } catch (error) {
        return mapWriteError(error);
    }
};

module.exports = {
    getSeasons,
    getSeason,
    createSeason,
    assignPersonnel,
    replacePersonnel,
    updateSeason,
    activateSeason,
    cancelSeason,
};
