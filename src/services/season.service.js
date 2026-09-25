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

const MAX_INITIAL_BIOMASS_KG = 99999999999.999;
const MAX_INITIAL_DENSITY_PER_M2 = 9999999999.99;
const CANCELLABLE_STATUSES = [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE];

const SEASON_BASE_SELECT = {
    id: true,
    pondId: true,
    name: true,
    shrimpType: true,
    stockingDate: true,
    expectedEndDate: true,
    actualEndDate: true,
    initialQuantity: true,
    initialAvgWeightG: true,
    initialBiomassKg: true,
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
        where: { unassignedAt: null },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        select: {
            id: true,
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
    initialAvgWeightG:
        season.initialAvgWeightG == null ? null : Number(season.initialAvgWeightG),
    initialBiomassKg:
        season.initialBiomassKg == null ? null : Number(season.initialBiomassKg),
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
            assignment.role === role && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    ) || null;

const buildActivationEligibility = (season) => {
    const missingConditions = [];
    const activeTechnicians = season.personnelAssignments.filter(
        (assignment) =>
            assignment.role === PERSONNEL_ROLE.TECHNICIAN
            && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    );
    const activeExperts = season.personnelAssignments.filter(
        (assignment) =>
            assignment.role === PERSONNEL_ROLE.EXPERT
            && assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    );

    if (season.status !== SEASON_STATUS.PLANNING) missingConditions.push('SEASON_NOT_PLANNING');
    if (season.pond.farm.isDeleted) missingConditions.push('FARM_ARCHIVED');
    if (season.pond.isDeleted) missingConditions.push('POND_ARCHIVED');
    if (season.pond.status !== 'AVAILABLE') missingConditions.push('POND_NOT_AVAILABLE');
    if (season.pond.type !== 'AQUACULTURE') missingConditions.push('POND_NOT_AQUACULTURE');
    if (!season.stockingDate) missingConditions.push('STOCKING_DATE_REQUIRED');
    if (season.initialQuantity == null) missingConditions.push('INITIAL_QUANTITY_REQUIRED');
    if (season.initialAvgWeightG == null) missingConditions.push('INITIAL_AVG_WEIGHT_REQUIRED');
    if (season.initialBiomassKg == null) missingConditions.push('INITIAL_BIOMASS_REQUIRED');
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

const calculateInitialMetrics = (initialQuantity, initialAvgWeightG, areaM2) => {
    if (initialQuantity == null || initialAvgWeightG == null) {
        return { initialBiomassKg: null, initialDensityPerM2: null };
    }

    const initialBiomassKg = Math.round(
        (Number(initialQuantity) * Number(initialAvgWeightG) / 1000) * 1000,
    ) / 1000;
    const initialDensityPerM2 = areaM2 == null
        ? null
        : Math.round((Number(initialQuantity) / Number(areaM2)) * 100) / 100;

    if (
        initialBiomassKg <= 0
        || initialBiomassKg > MAX_INITIAL_BIOMASS_KG
        || (initialDensityPerM2 != null && initialDensityPerM2 <= 0)
        || initialDensityPerM2 > MAX_INITIAL_DENSITY_PER_M2
    ) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.DERIVED_VALUE_OUT_OF_RANGE);
    }

    return { initialBiomassKg, initialDensityPerM2 };
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
    const metrics = calculateInitialMetrics(
        seasonData.initialQuantity,
        seasonData.initialAvgWeightG,
        areaM2,
    );

    return {
        pondId: seasonData.pondId,
        name: seasonData.name,
        shrimpType: seasonData.shrimpType,
        stockingDate,
        expectedEndDate,
        initialQuantity:
            seasonData.initialQuantity == null ? null : BigInt(seasonData.initialQuantity),
        initialAvgWeightG: seasonData.initialAvgWeightG ?? null,
        ...metrics,
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
    if (Object.hasOwn(seasonData, 'initialAvgWeightG')) {
        data.initialAvgWeightG = seasonData.initialAvgWeightG;
    }

    const nextStockingDate = Object.hasOwn(data, 'stockingDate')
        ? data.stockingDate
        : current.stockingDate;
    const nextExpectedEndDate = Object.hasOwn(data, 'expectedEndDate')
        ? data.expectedEndDate
        : current.expectedEndDate;
    assertDateRange(nextStockingDate, nextExpectedEndDate);

    if (
        Object.hasOwn(seasonData, 'initialQuantity')
        || Object.hasOwn(seasonData, 'initialAvgWeightG')
    ) {
        const nextQuantity = Object.hasOwn(data, 'initialQuantity')
            ? data.initialQuantity
            : current.initialQuantity;
        const nextWeight = Object.hasOwn(data, 'initialAvgWeightG')
            ? data.initialAvgWeightG
            : current.initialAvgWeightG;
        Object.assign(data, calculateInitialMetrics(nextQuantity, nextWeight, current.pond.areaM2));
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
                    updatedAt: expectedUpdatedAt,
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
            .filter((assignment) => assignment.account.status === ACCOUNT_STATUS.ACTIVE)
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
                    updatedAt: expectedUpdatedAt,
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
                    updatedAt: expectedUpdatedAt,
                },
                data: {
                    status: SEASON_STATUS.CANCELLED,
                    cancellationReason: reason,
                },
            });
            if (update.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
            }

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
    updateSeason,
    activateSeason,
    cancelSeason,
};
