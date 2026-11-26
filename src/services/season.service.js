const prisma = require('../config/prisma');
const { Prisma } = require('@prisma/client');
const lifecycle = require('./protocolLifecycle.service');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const { dateInVietnam } = require('../utils/productionSchedule');
const { cultureDay } = require('../utils/protocolTimeline');
const {
    httpStatus,
    messages,
    ACCOUNT_STATUS,
    FARM_STATUS,
    NOTIFICATION_TYPE,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    POND_STATUS,
    PRODUCT_CATEGORY,
    INVENTORY_TRANSACTION_TYPE,
    PROTOCOL_TYPE,
    DISEASE_CASE_STATUS,
} = require('../constants');

const MAX_INITIAL_DENSITY_PER_M2 = 9999999999.99;
const MaterialCostDecimal = Prisma.Decimal.clone({ precision: 50 });
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
    plannedStockingDate: true,
    activatedAt: true,
    activationDelayReason: true,
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
    farm: {
        select: {
            id: true,
            name: true,
            status: true,
            ownerId: true,
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
                    role: true,
                    managedByOwnerId: true,
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

/**
 * Expose optional season calendar dates in the API's YYYY-MM-DD format.
 */
const toDateOnly = (value) => (value ? value.toISOString().slice(0, 10) : null);
/**
 * Store an input calendar date at UTC midnight to preserve the date across time zones.
 */
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

/**
 * Count from the stocking date as day one using today's date in Vietnam.
 */
const dayOfCulture = (stockingDate) => {
    const days = cultureDay(stockingDate, new Date());
    return days > 0 ? days : null;
};

/**
 * Use numeric pond areas and the farm status casing expected by the season response.
 */
const normalizePondSummary = ({ farm: { ownerId, ...farm }, ...pond }) => ({
    ...pond,
    areaM2: pond.areaM2 == null ? null : Number(pond.areaM2),
    farm: { ...farm, status: farm.status?.toLowerCase() ?? null },
});

/**
 * Preserve stocking quantity precision and expose day of culture for active seasons.
 */
const normalizeSeasonBase = (season) => ({
    ...season,
    stockingDate: toDateOnly(season.stockingDate),
    plannedStockingDate: toDateOnly(season.plannedStockingDate),
    expectedEndDate: toDateOnly(season.expectedEndDate),
    actualEndDate: toDateOnly(season.actualEndDate),
    initialQuantity: season.initialQuantity == null ? null : season.initialQuantity.toString(),
    initialDensityPerM2:
        season.initialDensityPerM2 == null ? null : Number(season.initialDensityPerM2),
    dayOfCulture: season.status === SEASON_STATUS.ACTIVE ? dayOfCulture(season.stockingDate) : null,
});

/**
 * Return the season fields and pond context required by the owner's list.
 */
const normalizeSeasonSummary = ({ pond, ...season }) => ({
    ...normalizeSeasonBase(season),
    pond: normalizePondSummary(pond),
});

/**
 * Select a current assignment only when the assignee's account is active.
 */
const getActiveAssignment = (assignments, role) =>
    assignments.find(
        (assignment) =>
            assignment.role === role &&
            assignment.unassignedAt == null &&
            assignment.account.status === ACCOUNT_STATUS.ACTIVE,
    ) || null;

/**
 * Use the input's newest-first order to recover the most recent assignment for the role.
 */
const getLatestAssignment = (assignments, role) =>
    assignments.find((assignment) => assignment.role === role) || null;

/**
 * Provide the same eligibility check to the details view and activation transaction, including both
 * staff roles and a single approved production protocol.
 */
const buildActivationEligibility = (season, ownerId) => {
    const missingConditions = [];
    const countEligible = (role) => season.personnelAssignments.filter(
        ({ role: assignedRole, unassignedAt, account }) =>
            assignedRole === role && unassignedAt == null && account.role === role &&
            account.status === ACCOUNT_STATUS.ACTIVE && account.managedByOwnerId === ownerId,
    );

    if (season.status !== SEASON_STATUS.PLANNING) missingConditions.push('SEASON_NOT_PLANNING');
    if (season.pond.farm.status !== FARM_STATUS.ACTIVE) missingConditions.push('FARM_NOT_ACTIVE');
    if (season.pond.status !== POND_STATUS.AVAILABLE) missingConditions.push('POND_NOT_AVAILABLE');
    if (season.pond.type !== 'AQUACULTURE') missingConditions.push('POND_NOT_AQUACULTURE');
    if (season.initialQuantity == null || season.initialQuantity <= 0n)
        missingConditions.push('INITIAL_QUANTITY_REQUIRED');
    if (season.initialDensityPerM2 == null || Number(season.initialDensityPerM2) <= 0)
        missingConditions.push('INITIAL_DENSITY_REQUIRED');
    if (countEligible(PERSONNEL_ROLE.TECHNICIAN).length !== 1)
        missingConditions.push('ACTIVE_TECHNICIAN_REQUIRED');
    if (countEligible(PERSONNEL_ROLE.EXPERT).length !== 1)
        missingConditions.push('ACTIVE_EXPERT_REQUIRED');
    if (season.protocols.length !== 1 || season.protocols[0].status !== 'APPROVED') {
        missingConditions.push('APPROVED_PRODUCTION_PROTOCOL_REQUIRED');
    }

    return {
        canActivate: missingConditions.length === 0,
        missingConditions,
    };
};

/**
 * Assemble the season's location, current personnel, operational counts and activation eligibility.
 */
const normalizeSeasonDetail = ({
    personnelAssignments,
    protocols = [],
    pond,
    protocolCounts,
    diseaseCaseCounts,
    ...season
}) => {
    const activationEligibility = buildActivationEligibility({
        ...season,
        pond,
        personnelAssignments,
        protocols,
    }, pond.farm.ownerId);
    const technician = getActiveAssignment(personnelAssignments, PERSONNEL_ROLE.TECHNICIAN);
    const expert = getActiveAssignment(personnelAssignments, PERSONNEL_ROLE.EXPERT);

    const prodCount = protocolCounts?.production ?? (protocols.length > 0 ? 1 : 0);
    const treatCount = protocolCounts?.treatment ?? 0;
    const activeCases = diseaseCaseCounts?.active ?? 0;
    const totalCases = diseaseCaseCounts?.total ?? 0;
    const resolvedCases = diseaseCaseCounts?.resolved ?? 0;

    return {
        ...normalizeSeasonBase(season),
        pond: normalizePondSummary(pond),
        personnel: {
            technician,
            expert,
        },
        lastAssignedPersonnel: {
            technician: getLatestAssignment(personnelAssignments, PERSONNEL_ROLE.TECHNICIAN),
            expert: getLatestAssignment(personnelAssignments, PERSONNEL_ROLE.EXPERT),
        },
        approvedProductionProtocol: protocols[0] || null,
        protocolCounts: {
            production: prodCount,
            treatment: treatCount,
            total: prodCount + treatCount,
        },
        diseaseCaseCounts: {
            active: activeCases,
            resolved: resolvedCases,
            total: totalCases,
        },
        productionProtocolsCount: prodCount,
        treatmentProtocolsCount: treatCount,
        activeDiseaseCasesCount: activeCases,
        totalDiseaseCasesCount: totalCases,
        activationEligibility,
        availableActions: {
            update: season.status === SEASON_STATUS.PLANNING,
            activate: activationEligibility.canActivate,
            cancel: CANCELLABLE_STATUSES.includes(season.status),
        },
    };
};

/**
 * Scope the list to the owner's farms before applying pond, status and search filters.
 */
const buildSeasonWhere = (ownerId, { farmId, pondId, status, search } = {}) => ({
    pond: {
        ...(pondId && { id: pondId }),
        farm: {
            ownerId,
            ...(farmId && { id: farmId }),
        },
    },
    ...(status && { status }),
    ...(search && { name: { contains: search, mode: 'insensitive' } }),
});

/**
 * Use the caller's database client to load a season through its farm ownership.
 */
const findOwnedSeason = async (client, seasonId, ownerId, select = SEASON_DETAIL_SELECT) => {
    const season = await client.aquacultureSeason.findFirst({
        where: {
            id: seasonId,
            pond: { farm: { ownerId } },
        },
        select,
    });
    if (!season) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.SEASON.NOT_FOUND);
    }
    return season;
};

/**
 * Detect installations where optional season dependencies have not been provisioned.
 */
const dependencyTableExists = async (client, tableName) => {
    const [result] = await client.$queryRawUnsafe(
        'SELECT to_regclass($1) IS NOT NULL AS "exists"',
        `public.${tableName}`,
    );
    return result?.exists === true;
};

/**
 * Read versions eligible for activation and retain a second match so ambiguous activation can be
 * rejected.
 */
const getApprovedProductionProtocols = async (client, seasonId) => {
    if (!(await dependencyTableExists(client, 'protocols'))) return [];
    return client.$queryRawUnsafe(
        `SELECT id,
                title,
                version_no AS "versionNo",
                upper(status::text) AS status,
                reviewed_at AS "reviewedAt"
           FROM protocols
          WHERE season_id = $1::uuid
            AND protocol_type = 'production'
            AND status IN ('approved','active','paused')
          ORDER BY version_no DESC
          LIMIT 2`,
        seasonId,
    );
};

/**
 * Count production and treatment protocols and use zero totals when protocol storage is unavailable.
 */
const getProtocolCounts = async (client, seasonId) => {
    if (!client.protocol || typeof client.protocol.groupBy !== 'function') {
        return { production: 0, treatment: 0, total: 0 };
    }
    try {
        if (!(await dependencyTableExists(client, 'protocols'))) {
            return { production: 0, treatment: 0, total: 0 };
        }
        const counts = await client.protocol.groupBy({
            by: ['protocolType'],
            where: { seasonId },
            _count: { _all: true },
        });
        const production =
            counts.find(
                (c) =>
                    c.protocolType === PROTOCOL_TYPE.PRODUCTION ||
                    c.protocolType === 'production',
            )?._count?._all ?? 0;
        const treatment =
            counts.find(
                (c) =>
                    c.protocolType === PROTOCOL_TYPE.TREATMENT ||
                    c.protocolType === 'treatment',
            )?._count?._all ?? 0;
        return {
            production,
            treatment,
            total: production + treatment,
        };
    } catch {
        return { production: 0, treatment: 0, total: 0 };
    }
};

/**
 * Count resolved and unresolved cases and use zero totals when case storage is unavailable.
 */
const getDiseaseCaseCounts = async (client, seasonId) => {
    if (!client.diseaseCase || typeof client.diseaseCase.groupBy !== 'function') {
        return { active: 0, resolved: 0, total: 0 };
    }
    try {
        if (!(await dependencyTableExists(client, 'disease_cases'))) {
            return { active: 0, resolved: 0, total: 0 };
        }
        const counts = await client.diseaseCase.groupBy({
            by: ['status'],
            where: { seasonId },
            _count: { _all: true },
        });
        const resolved =
            counts.find(
                (c) =>
                    c.status === DISEASE_CASE_STATUS.RESOLVED ||
                    c.status === 'resolved',
            )?._count?._all ?? 0;
        const total = counts.reduce(
            (sum, entry) => sum + (entry._count?._all ?? 0),
            0,
        );
        const active = total - resolved;
        return {
            active,
            resolved,
            total,
        };
    } catch {
        return { active: 0, resolved: 0, total: 0 };
    }
};

/**
 * Load the dependencies used by season detail and activation from the same database client.
 */
const findOwnedSeasonDetail = async (client, seasonId, ownerId) => {
    const season = await findOwnedSeason(client, seasonId, ownerId);
    const [protocols, protocolCounts, diseaseCaseCounts] = await Promise.all([
        getApprovedProductionProtocols(client, seasonId),
        getProtocolCounts(client, seasonId),
        getDiseaseCaseCounts(client, seasonId),
    ]);
    return { ...season, protocols, protocolCounts, diseaseCaseCounts };
};

/**
 * Page the owner's filtered seasons and reject a cursor outside the visible result set.
 */
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

/**
 * Retrieves complete season details for an owned aquaculture season,
 * including aggregated material costs from historical stock-out transactions
 * and the derived estimated FCR from operational metrics.
 */
const getSeason = async (seasonId, ownerId) => {
    const season = await findOwnedSeasonDetail(prisma, seasonId, ownerId);
    // Sum stored stock-out amounts, retaining the price of each consumed lot.
    const sumCategory = (categories) => {
        if (!prisma.inventoryTransaction || typeof prisma.inventoryTransaction.aggregate !== 'function') {
            return Promise.resolve({ _sum: { totalAmount: 0 } });
        }
        return prisma.inventoryTransaction.aggregate({
            where: {
                seasonId,
                transactionType: INVENTORY_TRANSACTION_TYPE.STOCK_OUT,
                product: {
                    farmId: season.pond.farmId,
                    category: { in: categories },
                },
            },
            _sum: { totalAmount: true },
        });
    };
    const readOperationalMetrics = () => {
        if (!prisma.seasonOperationalMetrics || typeof prisma.seasonOperationalMetrics.findUnique !== 'function') {
            return Promise.resolve(null);
        }
        return prisma.seasonOperationalMetrics.findUnique({
            where: { seasonId },
            select: { estimatedFcr: true },
        });
    };
    // All categories must describe the same snapshot during concurrent stock-outs.
    const amountsPromises = [
        sumCategory([PRODUCT_CATEGORY.FEED]),
        sumCategory([PRODUCT_CATEGORY.MEDICINE]),
        sumCategory([PRODUCT_CATEGORY.MINERAL, PRODUCT_CATEGORY.CHEMICAL]),
    ];
    let amounts;
    try {
        amounts = await prisma.$transaction(amountsPromises, {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
    } catch {
        amounts = await Promise.all(amountsPromises);
    }
    const operationalMetrics = await readOperationalMetrics();
    const [feed, medicine, environment] = amounts.map(
        (result) => new MaterialCostDecimal(result._sum.totalAmount ?? 0),
    );
    return {
        ...normalizeSeasonDetail(season),
        estimatedFcr:
            operationalMetrics?.estimatedFcr == null
                ? null
                : Number(operationalMetrics.estimatedFcr),
        materialCosts: {
            currency: 'VND',
            feed: feed.toFixed(2),
            medicine: medicine.toFixed(2),
            environment: environment.toFixed(2),
            total: feed.plus(medicine).plus(environment).toFixed(2),
        },
    };
};

/**
 * Derive stocking density from initial quantity and pond area and enforce the permitted range.
 */
const calculateInitialDensity = (initialQuantity, areaM2) => {
    if (initialQuantity == null || areaM2 == null) return null;

    const density = Math.round((Number(initialQuantity) / Number(areaM2)) * 100) / 100;
    if (density <= 0 || density > MAX_INITIAL_DENSITY_PER_M2) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.DERIVED_VALUE_OUT_OF_RANGE);
    }
    return density;
};

/**
 * Require the planned end date to be on or after stocking when both dates are provided.
 */
const assertDateRange = (stockingDate, expectedEndDate) => {
    if (stockingDate && expectedEndDate && expectedEndDate < stockingDate) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.SEASON.INVALID_DATE_RANGE);
    }
};

/**
 * Normalize calendar dates and derive density before creating the season.
 */
const buildCreateData = (seasonData, ownerId, areaM2) => {
    const plannedStockingDate = parseDateOnly(seasonData.plannedStockingDate ?? seasonData.stockingDate);
    const expectedEndDate = parseDateOnly(seasonData.expectedEndDate);
    assertDateRange(plannedStockingDate, expectedEndDate);
    return {
        pondId: seasonData.pondId,
        name: seasonData.name,
        shrimpType: seasonData.shrimpType,
        plannedStockingDate,
        expectedEndDate,
        initialQuantity:
            seasonData.initialQuantity == null ? null : BigInt(seasonData.initialQuantity),
        initialDensityPerM2: calculateInitialDensity(seasonData.initialQuantity, areaM2),
        status: SEASON_STATUS.PLANNING,
        createdBy: ownerId,
    };
};

/**
 * Require an available aquaculture pond under an active farm.
 */
const assertEligiblePond = (pond) => {
    if (pond.farm.status !== FARM_STATUS.ACTIVE) {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.FARM_NOT_ACTIVE);
    }
    if (pond.status !== POND_STATUS.AVAILABLE) {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.POND_NOT_AVAILABLE);
    }
    if (pond.type !== 'AQUACULTURE') {
        throw new ApiError(httpStatus.CONFLICT, messages.SEASON.POND_NOT_AQUACULTURE);
    }
};

/**
 * Translate duplicate open seasons, stale pond references and write conflicts into season API errors.
 */
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

/**
 * Create a planning season only after checking ownership, pond eligibility and the absence of an open
 * season in the same transaction.
 */
const createSeason = async (seasonData, ownerId) => {
    try {
        const season = await prisma.$transaction(
            async (transaction) => {
                const pond = await transaction.pond.findFirst({
                    where: {
                        id: seasonData.pondId,
                        farm: { ownerId },
                    },
                    select: {
                        id: true,
                        areaM2: true,
                        type: true,
                        status: true,
                        farm: { select: { status: true } },
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
            },
            { isolationLevel: 'Serializable' },
        );

        return normalizeSeasonDetail(season);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Use the Vietnamese personnel role label in assignment notifications.
 */
const assignmentRoleLabel = (role) =>
    role === PERSONNEL_ROLE.TECHNICIAN ? 'Kỹ thuật viên' : 'Chuyên gia thủy sản';

const buildAssignmentNotificationContent = (role, seasonName) => {
    const content = `Bạn đã được phân công làm ${assignmentRoleLabel(role)} cho vụ nuôi ${seasonName}.`;
    return role === PERSONNEL_ROLE.EXPERT
        ? `${content} ${messages.SEASON.EXPERT_ASSIGNMENT_NOTIFICATION_HINT}`
        : content;
};

/**
 * Require an active account with the requested role managed by the same owner.
 */
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
        throw new ApiError(httpStatus.NOT_FOUND, messages.SEASON.ASSIGNMENT_PERSONNEL_NOT_ELIGIBLE);
    }
    return account;
};

/**
 * Map concurrent assignment or reference changes to the operation-specific conflict response.
 */
const mapPersonnelAssignmentWriteError = (error, conflictMessage) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, conflictMessage);
    }
    throw error;
};

/**
 * Check ownership and restrict staffing changes to assignable season states.
 */
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

/**
 * Reserve the role and account slots in one transaction after checking current assignments.
 */
const assignPersonnel = async (seasonId, { accountId, role }, ownerId) => {
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
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
                        content: buildAssignmentNotificationContent(role, season.name),
                        type: NOTIFICATION_TYPE.SEASON_ASSIGNMENT_CREATED,
                        referenceType: 'aquaculture_season',
                        referenceId: seasonId,
                    },
                    select: { id: true },
                });

                return { assignment, notificationId: notification.id };
            },
            { isolationLevel: 'Serializable' },
        );

        emitNotification(accountId, 'notification:new', {
            id: result.notificationId,
            referenceId: seasonId,
        });
        return result.assignment;
    } catch (error) {
        return mapPersonnelAssignmentWriteError(error, messages.SEASON.ASSIGNMENT_CONFLICT);
    }
};

/**
 * Move open technician tasks or unresolved expert cases to the replacement within the assignment
 * transaction.
 */
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

/**
 * Use the expected current assignment to prevent stale replacements and transfer ongoing work
 * atomically.
 */
const replacePersonnel = async (
    seasonId,
    role,
    { accountId, expectedAssignmentId, reason },
    ownerId,
) => {
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
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
                                `Bạn không còn phụ trách vai trò ${assignmentRoleLabel(role)} ` +
                                `cho vụ nuôi ${season.name}. Lý do: ${reason}`,
                            type: NOTIFICATION_TYPE.SEASON_ASSIGNMENT_REPLACED,
                            referenceType: 'aquaculture_season',
                            referenceId: seasonId,
                        },
                        {
                            accountId,
                            title: 'Bạn được phân công thay thế nhân sự',
                            content: buildAssignmentNotificationContent(role, season.name),
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
            },
            { isolationLevel: 'Serializable' },
        );

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
        return mapPersonnelAssignmentWriteError(error, messages.SEASON.REPLACEMENT_CONFLICT);
    }
};

/**
 * Validate the merged date range and recalculate density when the stocking quantity changes.
 */
const buildUpdateData = (seasonData, current) => {
    const data = {};
    for (const key of ['name', 'shrimpType']) {
        if (Object.hasOwn(seasonData, key)) data[key] = seasonData[key];
    }
    if (Object.hasOwn(seasonData, 'plannedStockingDate') || Object.hasOwn(seasonData, 'stockingDate')) {
        data.plannedStockingDate = parseDateOnly(seasonData.plannedStockingDate ?? seasonData.stockingDate);
    }
    if (Object.hasOwn(seasonData, 'expectedEndDate')) {
        data.expectedEndDate = parseDateOnly(seasonData.expectedEndDate);
    }
    if (Object.hasOwn(seasonData, 'initialQuantity')) {
        data.initialQuantity =
            seasonData.initialQuantity == null ? null : BigInt(seasonData.initialQuantity);
    }
    const nextStockingDate = Object.hasOwn(data, 'plannedStockingDate')
        ? data.plannedStockingDate
        : current.plannedStockingDate;
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

/**
 * Apply changes only while the season is still planning and matches the client's expected version.
 */
const updateSeason = async (seasonId, seasonData, ownerId) => {
    const { expectedUpdatedAt, ...editableData } = seasonData;
    try {
        const season = await prisma.$transaction(
            async (transaction) => {
                const current = await findOwnedSeason(
                    transaction,
                    seasonId,
                    ownerId,
                    SEASON_LIST_SELECT,
                );
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
            },
            { isolationLevel: 'Serializable' },
        );

        return normalizeSeasonDetail(season);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Prepare one status notification per active current assignee for persistence with the season change.
 */
const buildStatusNotifications = (season, { title, content }) => {
    const accountIds = [
        ...new Set(
            season.personnelAssignments
                .filter(
                    (assignment) =>
                        assignment.unassignedAt == null &&
                        assignment.account.status === ACCOUNT_STATUS.ACTIVE,
                )
                .map((assignment) => assignment.account.id),
        ),
    ];
    return {
        accountIds,
        data: accountIds.map((accountId) => ({
            accountId,
            title,
            content,
            type: NOTIFICATION_TYPE.SEASON_STATUS_CHANGED,
            referenceType: 'aquaculture_season',
            referenceId: season.id,
        })),
    };
};

/**
 * Signal committed season status changes to the affected inboxes.
 */
const emitStatusNotifications = (accountIds, seasonId) => {
    accountIds.forEach((accountId) => {
        emitNotification(accountId, 'notification:new', { referenceId: seasonId });
    });
};

/**
 * Cancel pending operations when a season closes and tolerate installations without schedule storage.
 */
const cancelPlannedOperationSchedules = async (client, seasonId, reason, ownerId, cancelledAt) => {
    if (!(await dependencyTableExists(client, 'operation_schedules'))) return 0;
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

/**
 * End every current assignment using the season cancellation timestamp.
 */
const unassignCurrentSeasonPersonnel = async (client, seasonId, ownerId, unassignedAt) =>
    client.seasonPersonnelAssignment.updateMany({
        where: {
            seasonId,
            unassignedAt: null,
        },
        data: {
            unassignedAt,
            unassignedBy: ownerId,
        },
    });

/**
 * Check activation prerequisites and the expected version in a transaction, then wake schedule
 * generation after commit.
 */
const activateSeason = async (seasonId, { expectedUpdatedAt, actualStockingDate, activationDelayReason }, ownerId) => {
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
                const current = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
                if (current.status !== SEASON_STATUS.PLANNING) {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.SEASON.ACTIVATION_REQUIRES_PLANNING,
                    );
                }
                const eligibility = buildActivationEligibility(current, ownerId);
                if (!eligibility.canActivate) {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.SEASON.ACTIVATION_CONDITIONS_NOT_MET,
                    );
                }
                const activatedAt = new Date();
                const today = dateInVietnam(activatedAt);
                if (actualStockingDate > today)
                    throw ApiError.badRequest(messages.SEASON.ACTIVATION_STOCKING_DATE_FUTURE);
                const delayed = actualStockingDate < today;
                const reason = activationDelayReason?.trim();
                if (delayed && !reason)
                    throw ApiError.badRequest(messages.SEASON.ACTIVATION_DELAY_REASON_REQUIRED);
                const stockingDate = parseDateOnly(actualStockingDate);
                assertDateRange(stockingDate, current.expectedEndDate);
                const approved = current.protocols.find(({ status }) => status === 'APPROVED');

                const update = await transaction.aquacultureSeason.updateMany({
                    where: {
                        id: seasonId,
                        status: SEASON_STATUS.PLANNING,
                        updatedAt: updatedAtApiWindow(expectedUpdatedAt),
                    },
                    data: {
                        status: SEASON_STATUS.ACTIVE,
                        stockingDate,
                        activatedAt,
                        activationDelayReason: delayed ? reason : null,
                    },
                });
                if (update.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.SEASON.CHANGE_CONFLICT);
                }
                const readiness = await lifecycle.resumeProduction(transaction, seasonId, activatedAt);
                if (!readiness?.canResume || readiness.protocolId !== approved.id) {
                    throw ApiError.conflict(
                        readiness?.code === 'NO_FUTURE_OCCURRENCE'
                            ? messages.SEASON.ACTIVATION_PROTOCOL_NO_FUTURE_OCCURRENCE
                            : messages.SEASON.ACTIVATION_PROTOCOL_NOT_READY,
                    );
                }

                const notifications = buildStatusNotifications(current, {
                    title: messages.SEASON.ACTIVATED_NOTIFICATION_TITLE,
                    content: `Vụ nuôi ${current.name} đã được kích hoạt.`,
                });
                if (notifications.data.length > 0) {
                    await transaction.notification.createMany({ data: notifications.data });
                }
                const season = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
                return { season, notificationAccountIds: notifications.accountIds };
            },
            { isolationLevel: 'Serializable' },
        );

        emitStatusNotifications(result.notificationAccountIds, seasonId);
        require('../jobs').requestSeason(seasonId);
        return normalizeSeasonDetail(result.season);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Cancel the season, close protocols, end assignments and retire planned operations in one
 * transaction.
 */
const cancelSeason = async (seasonId, { reason, expectedUpdatedAt }, ownerId) => {
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
                const current = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
                if (!CANCELLABLE_STATUSES.includes(current.status)) {
                    throw new ApiError(
                        httpStatus.CONFLICT,
                        messages.SEASON.CANCELLATION_NOT_ALLOWED,
                    );
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

                await lifecycle.closeSeason(transaction, seasonId, ownerId, true, cancelledAt);
                await unassignCurrentSeasonPersonnel(transaction, seasonId, ownerId, cancelledAt);
                const cancelledScheduleCount = await cancelPlannedOperationSchedules(
                    transaction,
                    seasonId,
                    reason,
                    ownerId,
                    cancelledAt,
                );
                const notifications = buildStatusNotifications(current, {
                    title: messages.SEASON.STATUS_CHANGED_NOTIFICATION_TITLE,
                    content: `Vụ nuôi ${current.name} đã bị hủy. Lý do: ${reason}`,
                });
                if (notifications.data.length > 0) {
                    await transaction.notification.createMany({ data: notifications.data });
                }
                const season = await findOwnedSeasonDetail(transaction, seasonId, ownerId);
                return {
                    season,
                    cancelledScheduleCount,
                    notificationAccountIds: notifications.accountIds,
                };
            },
            { isolationLevel: 'Serializable' },
        );

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
