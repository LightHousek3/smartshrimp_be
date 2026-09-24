const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
} = require('../constants');
const { dataAccess } = require('../plugins');

const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];

const FARM_SELECT = {
    id: true,
    ownerId: true,
    name: true,
    address: true,
    latitude: true,
    longitude: true,
    totalAreaHectares: true,
    isDeleted: true,
    deletedAt: true,
    createdAt: true,
    updatedAt: true,
};

const OPEN_SEASON_SELECT = {
    id: true,
    status: true,
    stockingDate: true,
};

const FARM_LIST_SELECT = {
    ...FARM_SELECT,
    ponds: {
        where: dataAccess.notDeleted(),
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
    ponds: {
        where: dataAccess.notDeleted(),
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

const normalizeFarm = (farm) => ({
    ...farm,
    latitude: farm.latitude == null ? null : Number(farm.latitude),
    longitude: farm.longitude == null ? null : Number(farm.longitude),
    totalAreaHectares:
        farm.totalAreaHectares == null ? null : Number(farm.totalAreaHectares),
});

const vietnamDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

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

const normalizeFarmSummary = (farm, { includePonds = false } = {}) => {
    const { ponds = [], ...baseFarm } = farm;
    const openSeasons = ponds.flatMap((pond) => pond.seasons || []);
    const normalized = {
        ...normalizeFarm(baseFarm),
        pondCount: ponds.length,
        activeSeasonCount: openSeasons.filter((season) => season.status === 'ACTIVE').length,
        canDelete: openSeasons.length === 0,
    };

    if (!includePonds) return normalized;
    return {
        ...normalized,
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

const getListFarm = async (ownerId) => {
    const farms = await prisma.farm.findMany({
        where: dataAccess.notDeleted({ ownerId }),
        select: FARM_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return farms.map((farm) => normalizeFarmSummary(farm));
};

const getFarmById = async (farmId, ownerId) => {
    const farm = await prisma.farm.findFirst({
        where: dataAccess.notDeleted({ id: farmId, ownerId }),
        select: FARM_DETAIL_SELECT,
    });

    if (!farm) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
    }

    return normalizeFarmSummary(farm, { includePonds: true });
};

const mapWriteError = (error) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002') {
        throw new ApiError(httpStatus.CONFLICT, messages.FARM.NAME_ALREADY_EXISTS);
    }
    if (error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, messages.FARM.CHANGE_CONFLICT);
    }
    throw error;
};

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

const updateFarm = async (farmId, farmData, ownerId) => {
    try {
        const farm = await prisma.$transaction(
            async (transaction) => {
                const currentFarm = await transaction.farm.findFirst({
                    where: dataAccess.notDeleted({ id: farmId, ownerId }),
                    select: { id: true },
                });

                if (!currentFarm) {
                    throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
                }
                const result = await transaction.farm.updateMany({
                    where: dataAccess.notDeleted({ id: farmId, ownerId }),
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

const deleteFarm = async (farmId, ownerId) => {
    try {
        const farm = await prisma.$transaction(
            async (transaction) => {
                const currentFarm = await transaction.farm.findFirst({
                    where: dataAccess.notDeleted({ id: farmId, ownerId }),
                    select: { id: true },
                });

                if (!currentFarm) {
                    throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
                }

                const openSeasonCount = await transaction.aquacultureSeason.count({
                    where: {
                        status: { in: OPEN_SEASON_STATUSES },
                        pond: { farmId },
                    },
                });

                if (openSeasonCount > 0) {
                    throw new ApiError(httpStatus.CONFLICT, messages.FARM.HAS_OPEN_SEASON);
                }

                const deletedAt = new Date();
                const mutableChildren = [
                    transaction.pond,
                    transaction.product,
                    transaction.productionProtocolTemplate,
                    transaction.task,
                ];
                for (const delegate of mutableChildren) {
                    await dataAccess.softDeleteMany({
                        delegate,
                        where: { farmId },
                        deletedAt,
                    });
                }

                const result = await dataAccess.softDeleteMany({
                    delegate: transaction.farm,
                    where: { id: farmId, ownerId },
                    deletedAt,
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
