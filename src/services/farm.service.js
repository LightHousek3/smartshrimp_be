const prisma = require('../config/prisma');
const { ProductionProtocolTemplateStatus: TEMPLATE_STATUS } = require('@prisma/client');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    FARM_STATUS,
    NOTIFICATION_TYPE,
} = require('../constants');

const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];

// Farm detail and mutation screens consume these fields.
const FARM_SELECT = {
    id: true,
    ownerId: true,
    name: true,
    address: true,
    latitude: true,
    longitude: true,
    totalAreaHectares: true,
    status: true,
};

const OPEN_SEASON_SELECT = {
    id: true,
    status: true,
    stockingDate: true,
};

const FARM_LIST_SELECT = {
    id: true,
    ownerId: true,
    name: true,
    address: true,
    status: true,
    ponds: {
        select: {
            id: true,
            seasons: {
                where: { status: { in: OPEN_SEASON_STATUSES } },
                select: { id: true, status: true },
            },
        },
    },
};

const FARM_DETAIL_SELECT = {
    ...FARM_SELECT,
    _count: {
        select: {
            ponds: true,
            products: true,
            tasks: true,
            productionProtocolTemplates: true,
        },
    },
    ponds: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
            id: true,
            name: true,
            areaM2: true,
            depthM: true,
            volumeM3: true,
            type: true,
            status: true,
            seasons: {
                where: { status: { in: OPEN_SEASON_STATUSES } },
                select: OPEN_SEASON_SELECT,
                take: 1,
            },
        },
    },
};

const normalizeFarm = (farm) => {
    const normalized = { ...farm };
    for (const field of ['latitude', 'longitude', 'totalAreaHectares']) {
        if (Object.hasOwn(farm, field) && farm[field] != null) {
            normalized[field] = Number(farm[field]);
        }
    }
    return normalized;
};

const vietnamDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/**
 * Count stocking day as DOC 1 against the Vietnam calendar, independent of server timezone.
 * Future or missing stocking dates have no current culture day.
 */
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

/**
 * Derive only the fields each App screen needs from open seasons and direct relations.
 * canDelete ignores detachable templates; deletion rechecks every FK transactionally.
 */
const normalizeFarmSummary = (farm, { includePonds = false } = {}) => {
    const { ponds = [], _count, ...baseFarm } = farm;
    const openSeasons = ponds.flatMap((pond) => pond.seasons || []);
    const normalized = {
        ...normalizeFarm(baseFarm),
        pondCount: ponds.length,
        activeSeasonCount: openSeasons.filter((season) => season.status === 'ACTIVE').length,
    };

    if (!includePonds) return normalized;
    return {
        ...normalized,
        canDelete: _count != null &&
            ['ponds', 'products', 'tasks'].every((relation) => _count[relation] === 0),
        templateCount: _count?.productionProtocolTemplates ?? 0,
        ponds: ponds.map(({ seasons = [], ...pond }) => {
            const currentSeason = seasons[0] || null;
            return {
                ...pond,
                areaM2: pond.areaM2 == null ? null : Number(pond.areaM2),
                depthM: pond.depthM == null ? null : Number(pond.depthM),
                volumeM3: pond.volumeM3 == null ? null : Number(pond.volumeM3),
                currentSeason:
                    currentSeason == null
                        ? null
                        : {
                              ...currentSeason,
                              dayOfCulture:
                                  currentSeason.status === 'ACTIVE'
                                      ? dayOfCulture(currentSeason.stockingDate)
                                      : null,
                          },
            };
        }),
    };
};

/**
 * List all farms owned by the authenticated Owner for client-side search and status filtering.
 */
const getListFarm = async (ownerId) => {
    const farms = await prisma.farm.findMany({
        where: { ownerId },
        select: FARM_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return farms.map((farm) => normalizeFarmSummary(farm));
};

/**
 * Read an owned farm, its persisted status and pond context for the detail screen.
 * Foreign IDs are indistinguishable from missing farms.
 */
const getFarmById = async (farmId, ownerId) => {
    const farm = await prisma.farm.findFirst({
        where: { id: farmId, ownerId },
        select: FARM_DETAIL_SELECT,
    });

    if (!farm) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
    }

    return normalizeFarmSummary(farm, { includePonds: true });
};

/**
 * Translate uniqueness, reference and serialization failures to actionable conflicts.
 * Unexpected database failures retain the global error handler’s internal-error behavior.
 */
const mapWriteError = (error) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002') {
        throw new ApiError(httpStatus.CONFLICT, messages.FARM.NAME_ALREADY_EXISTS);
    }
    if (error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
    }
    if (error.code === 'P2003') {
        throw new ApiError(httpStatus.CONFLICT, messages.FARM.HAS_REFERENCES);
    }
    if (error.code === 'P2022') {
        throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.FARM.TEMPORARILY_UNAVAILABLE);
    }
    throw error;
};

/**
 * Recheck the owner’s active role and create ownership in a serializable transaction.
 * Unique constraints arbitrate duplicate farm names, including concurrent requests.
 */
const createFarm = async (farmData, ownerId) => {
    try {
        const farm = await prisma.$transaction(
            async (transaction) => {
                const owner = await transaction.account.findFirst({
                    where: {
                        id: ownerId,
                        role: ACCOUNT_ROLE.FARM_OWNER,
                        status: ACCOUNT_STATUS.ACTIVE,
                    },
                    select: { id: true },
                });

                if (!owner) {
                    throw new ApiError(httpStatus.FORBIDDEN, messages.FARM.OWNER_NOT_ELIGIBLE);
                }

                return transaction.farm.create({
                    data: { ...farmData, ownerId },
                    select: FARM_SELECT,
                });
            },
            { isolationLevel: 'Serializable' },
        );

        return normalizeFarm(farm);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Keep ownership checks and status transitions in a serializable transaction.
 * Repeat ownership in updateMany and inspect count so a racing change cannot silently succeed.
 */
const updateFarm = async (farmId, farmData, ownerId) => {
    try {
        const farm = await prisma.$transaction(
            async (transaction) => {
                const currentFarm = await transaction.farm.findFirst({
                    where: { id: farmId, ownerId },
                    select: { id: true },
                });

                if (!currentFarm) {
                    throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
                }

                if (farmData.status === FARM_STATUS.INACTIVE) {
                    const openSeasonCount = await transaction.aquacultureSeason.count({
                        where: {
                            status: { in: OPEN_SEASON_STATUSES },
                            pond: { farmId },
                        },
                    });

                    if (openSeasonCount > 0) {
                        throw new ApiError(
                            httpStatus.CONFLICT,
                            messages.FARM.CANNOT_DEACTIVATE_WITH_OPEN_SEASONS,
                        );
                    }
                }

                const result = await transaction.farm.updateMany({
                    where: { id: farmId, ownerId },
                    data: farmData,
                });

                if (result.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
                }

                return transaction.farm.findUnique({
                    where: { id: farmId },
                    select: FARM_SELECT,
                });
            },
            { isolationLevel: 'Serializable' },
        );

        return normalizeFarm(farm);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Preserve templates as inactive Owner history, then physically delete an empty Farm.
 * Notification writes and detachment commit together; realtime emits only after commit.
 */
const deleteFarm = async (farmId, ownerId) => {
    try {
        const result = await prisma.$transaction(
            async (transaction) => {
                const currentFarm = await transaction.farm.findFirst({
                    where: { id: farmId, ownerId },
                    select: {
                        ...FARM_SELECT,
                        _count: FARM_DETAIL_SELECT._count,
                    },
                });

                if (!currentFarm) {
                    throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
                }

                if (['ponds', 'products', 'tasks'].some(
                    (relation) => currentFarm._count[relation] > 0
                )) {
                    throw new ApiError(httpStatus.CONFLICT, messages.FARM.HAS_REFERENCES);
                }

                const templates = await transaction.productionProtocolTemplate.findMany({
                    where: { farmId },
                    select: { id: true, title: true, createdBy: true },
                });
                if (templates.length !== currentFarm._count.productionProtocolTemplates) {
                    throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
                }
                if (templates.length > 0) {
                    const detached = await transaction.productionProtocolTemplate.updateMany({
                        where: { farmId },
                        data: {
                            farmId: null,
                            status: TEMPLATE_STATUS.inactive,
                            versionNo: { increment: 1 },
                        },
                    });
                    if (detached.count !== templates.length) {
                        throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
                    }
                    // The creator is the Expert responsible for each affected template.
                    await transaction.notification.createMany({
                        data: templates.map((template) => ({
                            accountId: template.createdBy,
                            type: NOTIFICATION_TYPE.SYSTEM,
                            referenceType: 'production_protocol_template',
                            referenceId: template.id,
                            title: messages.FARM.TEMPLATE_INACTIVATED_TITLE,
                            content: messages.FARM.templateInactivatedContent(
                                currentFarm.name, template.title
                            ).slice(0, 500),
                        })),
                    });
                }

                const deleted = await transaction.farm.deleteMany({
                    where: {
                        id: farmId,
                        ownerId,
                        ponds: { none: {} },
                        products: { none: {} },
                        tasks: { none: {} },
                        productionProtocolTemplates: { none: {} },
                    },
                });

                if (deleted.count !== 1) {
                    throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
                }

                const deletedFarm = { ...currentFarm };
                delete deletedFarm._count;
                return {
                    farm: deletedFarm,
                    notifiedExpertIds: [...new Set(templates.map((template) => template.createdBy))],
                };
            },
            { isolationLevel: 'Serializable' },
        );

        result.notifiedExpertIds.forEach((expertId) => {
            emitNotification(expertId, 'notification:new', {});
        });
        return normalizeFarm(result.farm);
    } catch (error) {
        return mapWriteError(error);
    }
};

module.exports = {
    FARM_SELECT,
    FARM_LIST_SELECT,
    FARM_DETAIL_SELECT,
    getListFarm,
    getFarmById,
    createFarm,
    updateFarm,
    deleteFarm,
};
