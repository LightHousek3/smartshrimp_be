const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');
const legacyRead = require('./inventoryLegacyRead.service');

const SUPPLIER_SELECT = {
    id: true,
    ownerId: true,
    name: true,
    supplierType: true,
    status: true,
    contactName: true,
    phone: true,
    email: true,
    address: true,
    note: true,
    createdAt: true,
    updatedAt: true,
    _count: {
        select: {
            manufacturedProducts: true,
            inventoryBalances: true,
        },
    },
};

const versionRange = (date) => ({
    gte: date,
    lt: new Date(date.getTime() + 1),
});
const nameKey = (name) => name.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');

/**
 * Authorize the navigation farm; supplier ownership comes directly from the session.
 */
const requireOwnedFarm = async (client, farmId, ownerId) => {
    const farm = await client.farm.findFirst({
        where: {
            id: farmId,
            ownerId,
        },
        select: { id: true },
    });
    if (!farm) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.INVENTORY.FARM_NOT_FOUND);
    }
};

/**
 * Unmapped template references also prevent deletion, even before a product is accepted.
 */
const deletionHints = async (client, ownerId) => {
    const rows = await client.$queryRaw(Prisma.sql`
        SELECT s.id, NOT (
            EXISTS (SELECT 1 FROM products p WHERE p.manufacturer_id = s.id)
            OR EXISTS (SELECT 1 FROM inventory_balances b WHERE b.supplier_id = s.id)
            OR EXISTS (SELECT 1 FROM production_protocol_template_items i WHERE i.recommended_manufacturer_id = s.id)
            OR EXISTS (SELECT 1 FROM protocol_items i WHERE i.recommended_manufacturer_id = s.id)
        ) AS "canDelete" FROM suppliers s WHERE s.owner_id = ${ownerId}::uuid`);
    return new Map(rows.map((row) => [row.id, row.canDelete]));
};

const normalizeSupplier = ({ _count, ...supplier }, hints) => ({
    ...supplier,
    schemaVersion: 2,
    readOnly: false,
    requiresSupplierType: supplier.supplierType == null,
    supplierType: supplier.supplierType ?? 'UNKNOWN',
    manufacturedProductCount: _count.manufacturedProducts,
    receiptCount: _count.inventoryBalances,
    status: supplier.status.toUpperCase(),
    isActive: supplier.status === 'active',
    canDelete: hints.get(supplier.id) === true,
});
const findSupplier = async (client, ownerId, supplierId) => {
    const supplier = await client.supplier.findFirst({
        where: {
            id: supplierId,
            ownerId,
        },
        select: SUPPLIER_SELECT,
    });
    if (!supplier) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.SUPPLIER.NOT_FOUND);
    }
    return supplier;
};

/**
 * Require an active owner supplier; manufacturer-specific links can additionally restrict roles.
 */
const requireSelectableSupplier = async (client, ownerId, supplierId, manufacturerOnly = false) => {
    await client.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId}::uuid AND owner_id = ${ownerId}::uuid FOR SHARE`;
    const supplier = await findSupplier(client, ownerId, supplierId);
    if (supplier.status !== 'active'
        || (manufacturerOnly && !['MANUFACTURER', 'BOTH'].includes(supplier.supplierType))) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.NOT_SELECTABLE);
    }
    return supplier;
};

/**
 * Keep owner-wide uniqueness and reference checks in the write transaction.
 */
const writeSupplier = async (work) => {
    try {
        return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.NAME_EXISTS);
        }
        if (error.code === 'P2003') {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.HAS_REFERENCES);
        }
        if (error.code === 'P2034') {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
        }
        throw error;
    }
};

const requireUniqueName = async (client, ownerId, name, excludedId) => {
    const candidates = await client.supplier.findMany({
        where: {
            ownerId,
            ...(excludedId && { id: { not: excludedId } }),
        },
        select: { name: true },
    });
    if (candidates.some((supplier) => nameKey(supplier.name) === nameKey(name))) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.NAME_EXISTS);
    }
};

const writeData = ({
    status, isActive, ...data
}) => ({
    ...data,
    ...(status !== undefined ? { status: status.toLowerCase() }
        : isActive !== undefined ? { status: isActive ? 'active' : 'inactive' } : {}),
});

/**
 * List active and inactive directory entries; canDelete includes every V2 FK reference.
 */
const getSuppliers = async (farmId, ownerId, {
    page = 1, limit = 100, search = '', supplierType, status,
} = {}) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const where = {
        ownerId,
        ...(supplierType && { supplierType }),
        ...(status && { status: status.toLowerCase() }),
        ...(search && {
            OR: ['name', 'contactName', 'phone', 'email'].map((field) => ({
                [field]: {
                    contains: search,
                    mode: 'insensitive',
                },
            })),
        }),
    };
    const [suppliers, totalResults, hints] = await Promise.all([
        prisma.supplier.findMany({
            where,
            select: SUPPLIER_SELECT,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.supplier.count({ where }),
        deletionHints(prisma, ownerId),
    ]);
    return {
        suppliers: suppliers.map((supplier) => normalizeSupplier(supplier, hints)),
        meta: {
            page,
            limit,
            totalResults,
            totalPages: Math.ceil(totalResults / limit),
            hasNextPage: page * limit < totalResults,
        },
    };
};

/**
 * Read an owner-wide supplier with bounded previews of its products and receipts.
 * Keep complete reference counts separate from the most recent preview rows.
 */
const getSupplier = async (farmId, supplierId, ownerId) => {
    await requireOwnedFarm(prisma, farmId, ownerId);
    const supplier = await findSupplier(prisma, ownerId, supplierId);
    // The directory is shared across this owner's farms. Bound related lists,
    // keeping total counts separate from these most recent previews.
    const [hints, manufacturedProducts, balances] = await Promise.all([
        deletionHints(prisma, ownerId),
        prisma.product.findMany({
            where: {
                manufacturerId: supplierId,
                farm: { ownerId },
            },
            select: {
                id: true,
                name: true,
                farmId: true,
                farm: { select: { name: true } },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
            take: 20,
        }),
        prisma.inventoryBalance.findMany({
            where: {
                supplierId,
                product: { farm: { ownerId } },
            },
            select: {
                id: true,
                productId: true,
                lotNumber: true,
                receivedAt: true,
                quantity: true,
                product: {
                    select: {
                        name: true,
                        farmId: true,
                        unit: true,
                        farm: { select: { name: true } },
                    },
                },
            },
            orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
            take: 20,
        }),
    ]);
    return {
        ...normalizeSupplier(supplier, hints),
        manufacturedProducts: manufacturedProducts.map(({ farm, ...product }) => ({
            ...product,
            farmName: farm.name,
        })),
        receipts: balances.map(({
            product, quantity, ...balance
        }) => ({
            ...balance,
            productName: product.name,
            farmId: product.farmId,
            farmName: product.farm.name,
            quantityExact: quantity.toFixed(),
            unit: product.unit,
        })),
    };
};

/**
 * ownerId is always taken from the session, never from the supplied body or farm.
 */
const createSupplier = (farmId, data, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await requireUniqueName(client, ownerId, data.name);
    const supplier = await client.supplier.create({
        data: {
            ...writeData(data),
            ownerId,
            updatedAt: new Date(),
        },
        select: SUPPLIER_SELECT,
    });
    return normalizeSupplier(supplier, new Map([[supplier.id, true]]));
});

/**
 * Inactivation leaves existing stock usable; changing the manufacturer role must preserve links.
 */
const updateSupplier = (farmId, supplierId, input, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await client.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
    await findSupplier(client, ownerId, supplierId);
    const { expectedUpdatedAt, ...data } = input;
    if (data.name) {
        await requireUniqueName(client, ownerId, data.name, supplierId);
    }
    if (data.supplierType === 'DISTRIBUTOR') {
        const [references] = await client.$queryRaw(Prisma.sql`
            SELECT EXISTS(SELECT 1 FROM products WHERE manufacturer_id = ${supplierId}::uuid)
                OR EXISTS(SELECT 1 FROM production_protocol_template_items WHERE recommended_manufacturer_id = ${supplierId}::uuid)
                OR EXISTS(SELECT 1 FROM protocol_items WHERE recommended_manufacturer_id = ${supplierId}::uuid) AS used`);
        if (references.used) {
            throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.MANUFACTURER_REFERENCED);
        }
    }
    const result = await client.supplier.updateMany({
        where: {
            id: supplierId,
            ownerId,
            updatedAt: versionRange(expectedUpdatedAt),
        },
        data: {
            ...writeData(data),
            updatedAt: new Date(),
        },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
    return normalizeSupplier(await findSupplier(client, ownerId, supplierId), await deletionHints(client, ownerId));
});

/**
 * Hard-delete only an unreferenced directory record; database FKs arbitrate racing references.
 */
const deleteSupplier = (farmId, supplierId, ownerId) => writeSupplier(async (client) => {
    await requireOwnedFarm(client, farmId, ownerId);
    await client.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplierId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
    await findSupplier(client, ownerId, supplierId);
    if (!(await deletionHints(client, ownerId)).get(supplierId)) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.HAS_REFERENCES);
    }
    const result = await client.supplier.deleteMany({
        where: {
            id: supplierId,
            ownerId,
        },
    });
    if (result.count !== 1) {
        throw new ApiError(httpStatus.CONFLICT, messages.SUPPLIER.CHANGE_CONFLICT);
    }
});

module.exports = {
    getSuppliers: async (...args) => (await legacyRead.isV2() ? getSuppliers : legacyRead.getSuppliers)(...args),
    getSupplier: async (...args) => (await legacyRead.isV2() ? getSupplier : legacyRead.getSupplier)(...args),
    createSupplier: legacyRead.guardWrite(createSupplier),
    updateSupplier: legacyRead.guardWrite(updateSupplier),
    deleteSupplier: legacyRead.guardWrite(deleteSupplier),
    requireSelectableSupplier: legacyRead.guardWrite(requireSelectableSupplier),
};
