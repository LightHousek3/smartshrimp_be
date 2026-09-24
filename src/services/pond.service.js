const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');
const { dataAccess } = require('../plugins');

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

const POND_SELECT = {
    id: true,
    farmId: true,
    name: true,
    areaM2: true,
    depthM: true,
    volumeM3: true,
    type: true,
    status: true,
    deletedAt: true,
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

const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: dataAccess.notDeleted({ id: farmId, ownerId }),
        select: { id: true },
    });
    if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.POND.NOT_FOUND);
    return farm;
};

const requireUniquePondName = async (client, farmId, name, excludedPondId) => {
    const ponds = await client.pond.findMany({
        where: dataAccess.notDeleted({
            farmId,
            ...(excludedPondId && { id: { not: excludedPondId } }),
        }),
        select: { name: true },
    });
    const nameKey = normalizePondNameKey(name);
    if (ponds.some((pond) => normalizePondNameKey(pond.name) === nameKey)) {
        throw new ApiError(httpStatus.CONFLICT, messages.POND.NAME_ALREADY_EXISTS);
    }
};

const getPonds = async (farmId, ownerId, query) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const { page, limit, search, status, type } = query;
    const where = dataAccess.notDeleted({
        farmId,
        ...(search && { name: { contains: search, mode: 'insensitive' } }),
        ...(status && { status }),
        ...(type && { type }),
    });
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
        where: dataAccess.notDeleted({ id: pondId, farmId, farm: dataAccess.notDeleted({ ownerId }) }),
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
            await requireOwnedFarm(transaction, farmId, ownerId);
            await requireUniquePondName(transaction, farmId, pondData.name);
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
                where: dataAccess.notDeleted({ id: pondId, farmId }),
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

const deletePond = async (farmId, pondId, ownerId) => {
    try {
        const pond = await prisma.$transaction(async (transaction) => {
            await requireOwnedFarm(transaction, farmId, ownerId);
            await findOwnedPond(
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
            const result = await dataAccess.softDeleteMany({
                delegate: transaction.pond,
                where: { id: pondId, farmId },
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

module.exports = { getPonds, getPond, createPond, updatePond, deletePond };
