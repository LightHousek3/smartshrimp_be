const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];
const MAX_VOLUME_M3 = 999999999999.99;

const calculateVolumeM3 = (areaM2, depthM) => {
    if (areaM2 == null || depthM == null) return null;
    const volumeM3 = Math.round(Number(areaM2) * Number(depthM) * 100) / 100;
    if (volumeM3 > MAX_VOLUME_M3) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.POND.VOLUME_OUT_OF_RANGE);
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
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
};

const POND_DETAIL_SELECT = {
    ...POND_SELECT,
    farm: {
        select: { id: true, name: true, archivedAt: true },
    },
    seasons: {
        where: { status: { in: OPEN_SEASON_STATUSES } },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, stockingDate: true },
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

const requireOwnedFarm = async (client, farmId, ownerId, { active = false } = {}) => {
    const farm = await client.farm.findFirst({
        where: { id: farmId, ownerId },
        select: { id: true, archivedAt: true },
    });
    if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.POND.NOT_FOUND);
    if (active && farm.archivedAt) {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.FARM_ARCHIVED);
    }
    return farm;
};

const getPonds = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const { page, limit, search, status, type, archived } = query;
    const where = {
        farmId,
        archivedAt: archived ? { not: null } : null,
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
    throw error;
};

const createPond = async (farmId, pondData, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId, { active: true });
            return transaction.pond.create({
                data: {
                    ...pondData,
                    farmId,
                    volumeM3: calculateVolumeM3(pondData.areaM2, pondData.depthM),
                },
                select: POND_SELECT,
            });
        }, { isolationLevel: 'Serializable' });
        return normalizePond(pond);
    } catch (error) {
        return mapWriteError(error);
    }
};

const updatePond = async (farmId, pondId, pondData, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId, { active: true });
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
            if (current.archivedAt) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.ARCHIVED_UPDATE_FORBIDDEN);
            }
            const nextAreaM2 = Object.hasOwn(pondData, 'areaM2')
                ? pondData.areaM2
                : current.areaM2;
            const nextDepthM = Object.hasOwn(pondData, 'depthM')
                ? pondData.depthM
                : current.depthM;
            const recalculatesVolume = Object.hasOwn(pondData, 'areaM2')
                || Object.hasOwn(pondData, 'depthM');
            const updateData = {
                ...pondData,
                ...(recalculatesVolume && {
                    volumeM3: calculateVolumeM3(nextAreaM2, nextDepthM),
                }),
            };
            const hasOpenSeason = current.seasons.length > 0;
            const changesProtectedType = pondData.type !== undefined
                && pondData.type !== current.type;
            const changesToInactive = pondData.status === 'INACTIVE'
                && current.status !== 'INACTIVE';
            const changesVolume = recalculatesVolume
                && Number(updateData.volumeM3) !== Number(current.volumeM3);
            if (hasOpenSeason && (changesProtectedType || changesToInactive || changesVolume)) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.OPEN_SEASON_RESTRICTS_UPDATE);
            }
            const result = await transaction.pond.updateMany({
                where: { id: pondId, farmId, archivedAt: null },
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

const archivePond = async (farmId, pondId, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId, { active: true });
            const current = await findOwnedPond(
                transaction,
                farmId,
                pondId,
                ownerId,
                POND_SELECT,
            );
            if (current.archivedAt) return current;
            const openSeasonCount = await transaction.aquacultureSeason.count({
                where: { pondId, status: { in: OPEN_SEASON_STATUSES } },
            });
            if (openSeasonCount > 0) {
                throw new ApiError(httpStatus.CONFLICT, messages.POND.HAS_OPEN_SEASON);
            }
            const result = await transaction.pond.updateMany({
                where: { id: pondId, farmId, archivedAt: null },
                data: { archivedAt: new Date() },
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

const restorePond = async (farmId, pondId, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId, { active: true });
            const current = await findOwnedPond(
                transaction,
                farmId,
                pondId,
                ownerId,
                POND_SELECT,
            );
            if (!current.archivedAt) return current;
            const result = await transaction.pond.updateMany({
                where: { id: pondId, farmId, archivedAt: { not: null } },
                data: { archivedAt: null },
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

module.exports = { getPonds, getPond, createPond, updatePond, archivePond, restorePond };
