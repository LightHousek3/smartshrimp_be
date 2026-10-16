const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const SUPPLIER_SELECT = {
    id: true, farmId: true, name: true, contactName: true, phone: true,
    email: true, address: true, note: true, createdAt: true, updatedAt: true,
};

const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: { id: farmId, ownerId, isDeleted: false },
        select: { id: true },
    });
    if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.FARM_NOT_FOUND);
};

const findSupplier = async (client, farmId, supplierId) => {
    const supplier = await client.supplier.findFirst({
        where: { id: supplierId, farmId, isDeleted: false },
        select: SUPPLIER_SELECT,
    });
    if (!supplier) throw new ApiError(httpStatus.NOT_FOUND, messages.SUPPLIER.NOT_FOUND);
    return supplier;
};

const getSuppliers = async (farmId, ownerId, { page = 1, limit = 100, search = '' } = {}) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const where = {
        farmId, isDeleted: false,
        ...(search && { OR: ['name', 'contactName', 'phone', 'email'].map((field) => ({
            [field]: { contains: search, mode: 'insensitive' },
        })) }),
    };
    const [suppliers, totalResults] = await Promise.all([
        prisma.supplier.findMany({
            where, select: SUPPLIER_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit, take: limit,
        }),
        prisma.supplier.count({ where }),
    ]);
    return {
        suppliers,
        meta: { page, limit, totalResults, totalPages: Math.ceil(totalResults / limit),
            hasNextPage: page * limit < totalResults },
    };
};

const getSupplier = async (farmId, supplierId, ownerId) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    return findSupplier(prisma, farmId, supplierId);
};

const writeSupplier = async (operation) => {
    try {
        return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.NAME_EXISTS);
        }
        if (error.code === 'P2034') {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
        }
        throw error;
    }
};

const createSupplier = (farmId, data, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    // Keep the version token at JavaScript millisecond precision from creation.
    return client.supplier.create({
        data: { ...data, farmId, updatedAt: new Date() }, select: SUPPLIER_SELECT,
    });
});

const updateSupplier = (farmId, supplierId, input, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await findSupplier(client, farmId, supplierId);
    const { expectedUpdatedAt, ...data } = input;
    const result = await client.supplier.updateMany({
        where: { id: supplierId, farmId, isDeleted: false, updatedAt: expectedUpdatedAt },
        data: { ...data, updatedAt: new Date() },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
    return findSupplier(client, farmId, supplierId);
});

const deleteSupplier = (farmId, supplierId, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await findSupplier(client, farmId, supplierId);
    const now = new Date();
    const result = await client.supplier.updateMany({
        where: { id: supplierId, farmId, isDeleted: false },
        data: { isDeleted: true, deletedAt: now, updatedAt: now },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
    // Keep the FK and the receipt's supplierName snapshot for historical records.
});

module.exports = { getSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
