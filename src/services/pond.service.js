const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];
const MAX_VOLUME_M3 = 999999999999.99;

const normalizePondNameKey = (name) => name.replace(/\s+/gu, '').toLocaleLowerCase('vi');

const calculateVolumeM3 = (areaM2, depthM) => {
    if (areaM2 == null || depthM == null) return null;
    const volumeM3 = Math.round(Number(areaM2) * Number(depthM) * 100) / 100;
    if (volumeM3 > MAX_VOLUME_M3) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.POND.VOLUME_OUT_OF_RANGE);
    }
    return volumeM3;
};

const resolveVolumeM3 = (areaM2, depthM, suppliedVolumeM3) => {
    const calculatedVolumeM3 = calculateVolumeM3(areaM2, depthM);
    if (suppliedVolumeM3 === undefined) return calculatedVolumeM3;
    const volumeM3 = Number(suppliedVolumeM3);
    if (volumeM3 > calculatedVolumeM3) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.POND.VOLUME_EXCEEDS_CAPACITY);
    }
    return volumeM3;
};

const POND_SELECT = {
    id: true,
    farmId: true,
    name: true,
    areaM2: true,
    depthM: true,
    volumeM3: true,
    type: true,
    status: true,
    createdAt: true,
    updatedAt: true,
};

const POND_DETAIL_SELECT = {
    ...POND_SELECT,
    farm: {
        select: { id: true, name: true },
    },
    seasons: {
        where: { status: { in: OPEN_SEASON_STATUSES } },
        orderBy: { id: 'asc' },
        select: { id: true, name: true, status: true, stockingDate: true },
        take: 1,
    },
};

const normalizePond = (pond) => ({
    ...pond,
    areaM2: pond.areaM2 == null ? null : Number(pond.areaM2),
    depthM: pond.depthM == null ? null : Number(pond.depthM),
    volumeM3: pond.volumeM3 == null ? null : Number(pond.volumeM3),
});

const normalizePondDetail = ({ seasons = [], ...pond }) => ({
    ...normalizePond(pond),
    currentSeason: seasons[0] || null,
});

const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: { id: farmId, ownerId },
        select: { id: true },
    });
    if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.POND.NOT_FOUND);
    return farm;
};

const requireUniquePondName = async (client, farmId, name, excludedPondId) => {
    const ponds = await client.pond.findMany({
        where: {
            farmId,
            ...(excludedPondId && { id: { not: excludedPondId } }),
        },
        select: { name: true },
    });
    const nameKey = normalizePondNameKey(name);
    if (ponds.some((pond) => normalizePondNameKey(pond.name) === nameKey)) {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.NAME_ALREADY_EXISTS);
    }
};

/**
 * List ponds in an owned farm with filters and pagination.
 * Farm ownership is checked before reading ponds or counting results.
 */
const getPonds = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const { page, limit, search, status, type } = query;
    const where = {
        farmId,
        ...(search && { name: { contains: search, mode: 'insensitive' } }),
        ...(status && { status }),
        ...(type && { type }),
    };
    const [ponds, totalResults] = await Promise.all([
        prisma.pond.findMany({
            where,
            select: POND_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.pond.count({ where }),
    ]);
    return {
        ponds: ponds.map(normalizePond),
        meta: {
            page,
            limit,
            totalResults,
            totalPages: Math.ceil(totalResults / limit),
            hasNextPage: page * limit < totalResults,
        },
    };
};

const findOwnedPond = async (client, farmId, pondId, ownerId, select) => {
    const pond = await client.pond.findFirst({
        where: { id: pondId, farmId, farm: { ownerId } },
        select,
    });
    if (!pond) throw new ApiError(httpStatus.NOT_FOUND, messages.POND.NOT_FOUND);
    return pond;
};

/**
 * Get an owned pond with its current planning or active season.
 * Decimal measurements are converted to numbers in the response.
 */
const getPond = async (farmId, pondId, ownerId) => {
    const pond = await findOwnedPond(prisma, farmId, pondId, ownerId, POND_DETAIL_SELECT);
    return normalizePondDetail(pond);
};

const mapWriteError = (error) => {
    if (error instanceof ApiError) throw error;
    if (error.code === 'P2002') {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.NAME_ALREADY_EXISTS);
    }
    if (error.code === 'P2034') {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.CHANGE_CONFLICT);
    }
    if (error.code === 'P2003') {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.HAS_REFERENCES);
    }
    throw error;
};

/**
 * Create a pond in an owned farm and resolve its usable water volume.
 * Name uniqueness and creation share a serializable transaction.
 */
const createPond = async (farmId, pondData, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId);
            await requireUniquePondName(transaction, farmId, pondData.name);
            return transaction.pond.create({
                data: {
                    ...pondData,
                    farmId,
                    volumeM3: resolveVolumeM3(
                        pondData.areaM2,
                        pondData.depthM,
                        pondData.volumeM3,
                    ),
                },
                select: POND_SELECT,
            });
        }, { isolationLevel: 'Serializable' });
        return normalizePond(pond);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Update an owned pond and recalculate volume when dimensions change.
 * An open season prevents changes to pond type, volume or inactive status.
 * Ownership, name uniqueness and updates share a serializable transaction.
 */
const updatePond = async (farmId, pondId, pondData, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId);
            const current = await findOwnedPond(
                transaction,
                farmId,
                pondId,
                ownerId,
                { ...POND_SELECT, seasons: {
                    where: { status: { in: OPEN_SEASON_STATUSES } },
                    select: { id: true },
                    take: 1,
                } },
            );
            if (pondData.name !== undefined) {
                await requireUniquePondName(transaction, farmId, pondData.name, pondId);
            }
            const nextAreaM2 = Object.hasOwn(pondData, 'areaM2')
                ? pondData.areaM2
                : current.areaM2;
            const nextDepthM = Object.hasOwn(pondData, 'depthM')
                ? pondData.depthM
                : current.depthM;
            const resolvesVolume = Object.hasOwn(pondData, 'areaM2')
                || Object.hasOwn(pondData, 'depthM')
                || Object.hasOwn(pondData, 'volumeM3');
            const updateData = {
                ...pondData,
                ...(resolvesVolume && {
                    volumeM3: resolveVolumeM3(
                        nextAreaM2,
                        nextDepthM,
                        pondData.volumeM3,
                    ),
                }),
            };
            const hasOpenSeason = current.seasons.length > 0;
            const changesProtectedType = pondData.type !== undefined
                && pondData.type !== current.type;
            const changesToInactive = pondData.status === 'INACTIVE'
                && current.status !== 'INACTIVE';
            const changesVolume = resolvesVolume
                && Number(updateData.volumeM3) !== Number(current.volumeM3);
            if (hasOpenSeason && (changesProtectedType || changesToInactive || changesVolume)) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.OPEN_SEASON_RESTRICTS_UPDATE);
            }
            const result = await transaction.pond.updateMany({
                where: { id: pondId, farmId },
                data: updateData,
            });
            if (result.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.CHANGE_CONFLICT);
            }
            return transaction.pond.findUnique({ where: { id: pondId }, select: POND_SELECT });
        }, { isolationLevel: 'Serializable' });
        return normalizePond(pond);
    } catch (error) {
        return mapWriteError(error);
    }
};

/**
 * Delete an owned pond only when it has no planning or active season.
 * RESTRICT foreign keys reject deletion if any season history still refers to it.
 * Ownership and season checks run in the same transaction as deletion.
 */
const deletePond = async (farmId, pondId, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId);
            const currentPond = await findOwnedPond(
                transaction,
                farmId,
                pondId,
                ownerId,
                POND_SELECT,
            );
            const openSeasonCount = await transaction.aquacultureSeason.count({
                where: { pondId, status: { in: OPEN_SEASON_STATUSES } },
            });
            if (openSeasonCount > 0) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.HAS_OPEN_SEASON);
            }
            const result = await transaction.pond.deleteMany({
                where: { id: pondId, farmId },
            });
            if (result.count !== 1) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.CHANGE_CONFLICT);
            }
            return currentPond;
        }, { isolationLevel: 'Serializable' });
        return normalizePond(pond);
    } catch (error) {
        return mapWriteError(error);
    }
};

module.exports = { getPonds, getPond, createPond, updatePond, deletePond };
