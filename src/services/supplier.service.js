const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const SUPPLIER_SELECT = {
    id: true, farmId: true, name: true, contactName: true, phone: true,
    email: true, address: true, note: true, isActive: true, createdAt: true, updatedAt: true,
};

/**
 * Authorize the destination farm before accessing the owner-wide supplier directory.
 */
const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: { id: farmId, ownerId, isDeleted: false },
        select: { id: true },
    });
    if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.FARM_NOT_FOUND);
};

// The originating farm is retained for history; its owner owns the shared directory.
const supplierScope = (ownerId) => ({ farm: { ownerId }, isDeleted: false });
// Preserve optimistic locking for pre-existing rows with PostgreSQL microseconds.
const versionRange = (date) => ({ gte: date, lt: new Date(date.getTime() + 1) });

/**
 * Mask missing, deleted and foreign-owner suppliers with the same not-found response.
 */
const findSupplier = async (client, ownerId, supplierId) => {
    const supplier = await client.supplier.findFirst({
        where: { id: supplierId, ...supplierScope(ownerId) },
        select: SUPPLIER_SELECT,
    });
    if (!supplier) throw new ApiError(httpStatus.NOT_FOUND, messages.SUPPLIER.NOT_FOUND);
    return supplier;
};

/**
 * Search the owner directory across farms after validating the destination farm.
 * Include active and inactive suppliers with deterministic ordering and pagination.
 */
const getSuppliers = async (farmId, ownerId, { page = 1, limit = 100, search = '' } = {}) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const where = {
        ...supplierScope(ownerId),
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

/**
 * Read a supplier from any farm of the same owner after checking destination access.
 */
const getSupplier = async (farmId, supplierId, ownerId) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    return findSupplier(prisma, ownerId, supplierId);
};

/**
 * Keep supplier checks and writes in a serializable transaction.
 * Translate uniqueness and serialization failures without hiding unexpected errors.
 */
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

/**
 * Reserve normalized supplier names across the owner directory, including inactive rows.
 * Exclude the current supplier on updates; deleted rows do not reserve names.
 */
const requireUniqueName = async (client, ownerId, name, excludedId) => {
    const candidates = await client.supplier.findMany({
        where: { ...supplierScope(ownerId), ...(excludedId && { id: { not: excludedId } }) },
        select: { name: true },
    });
    const key = (value) => value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');
    if (candidates.some((supplier) => key(supplier.name) === key(name))) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.NAME_EXISTS);
    }
};

/**
 * Create an owner-shared supplier while retaining the originating farm for history.
 * Check owner-wide name uniqueness in the same transaction as the insert.
 */
const createSupplier = (farmId, data, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await requireUniqueName(client, ownerId, data.name);
    // Keep the version token at JavaScript millisecond precision from creation.
    return client.supplier.create({
        data: { ...data, farmId, updatedAt: new Date() }, select: SUPPLIER_SELECT,
    });
});

/**
 * Update an owner-shared supplier using the API version token to reject stale edits.
 * Keep the originating farm unchanged when editing from another farm of the same owner.
 */
const updateSupplier = (farmId, supplierId, input, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await findSupplier(client, ownerId, supplierId);
    const { expectedUpdatedAt, ...data } = input;
    if (data.name) await requireUniqueName(client, ownerId, data.name, supplierId);
    const result = await client.supplier.updateMany({
        where: { id: supplierId, ...supplierScope(ownerId), updatedAt: versionRange(expectedUpdatedAt) },
        data: { ...data, updatedAt: new Date() },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
    return findSupplier(client, ownerId, supplierId);
});

/**
 * Soft-delete an owner-shared supplier without breaking lot references or receipt snapshots.
 */
const deleteSupplier = (farmId, supplierId, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await findSupplier(client, ownerId, supplierId);
    const now = new Date();
    const result = await client.supplier.updateMany({
        where: { id: supplierId, ...supplierScope(ownerId) },
        data: { isDeleted: true, deletedAt: now, updatedAt: now },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
    // Keep the FK and the receipt's supplierName snapshot for historical records.
});

module.exports = { getSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
