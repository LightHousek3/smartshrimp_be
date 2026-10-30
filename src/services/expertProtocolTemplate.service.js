const prisma = require('../config/prisma');
const {
    Prisma,
    ProductionProtocolTemplateStatus: TemplateStatus,
} = require('@prisma/client');
const {
    ApiError,
    assertTemplateDose,
    applicationRuns,
    getMaterialSafety,
    assertMaterialSafety,
    assessTemplateProposal,
    productFromRecommendation,
} = require('../utils');
const { messages, FARM_STATUS } = require('../constants');

const notFound = () =>
    ApiError.notFound(messages.EXPERT_PROTOCOL_TEMPLATE.NOT_FOUND);
const scope = (ownerId) => ({ farm: { ownerId, status: FARM_STATUS.ACTIVE } });
const headerSelect = {
    id: true,
    title: true,
    description: true,
    shrimpType: true,
    allowedVariancePct: true,
    versionNo: true,
    status: true,
    farm: { select: { id: true, name: true } },
    _count: { select: { sourcedProtocols: true } },
};
const materialSelect = {
    id: true,
    farmId: true,
    name: true,
    category: true,
    unit: true,
    conversionQuantity: true,
    conversionUnit: true,
    description: true,
    imageUrls: true,
    recommendationReason: true,
    minAlertQuantity: true,
    status: true,
    manufacturerId: true,
    compliance: true,
};
const normalizeManufacturer = (row) =>
    row ? { ...row, supplierType: row.supplierType?.toLowerCase() ?? null } : null;
const normalizeCompliance = (details) =>
    details
        ? {
              ...details,
              withdrawalDays:
                  details.withdrawalDays == null
                      ? null
                      : Number(details.withdrawalDays),
          }
        : null;
const normalizeMaterial = ({ compliance, ...product }) => ({
    ...product,
    conversionQuantity:
        product.conversionQuantity == null
            ? null
            : Number(product.conversionQuantity),
    minAlertQuantity: Number(product.minAlertQuantity ?? 0),
    productCompliance: normalizeCompliance(compliance ?? product.productCompliance),
    safety: getMaterialSafety({
        ...product,
        productCompliance: compliance ?? product.productCompliance,
    }),
});

// Count distinct approved/applied seasons separately from references that prevent deletion.
const applications = (ownerId, ids) =>
    prisma.protocol.groupBy({
        by: ['sourceTemplateId', 'seasonId'],
        where: {
            sourceTemplateId: { in: ids },
            protocolType: 'PRODUCTION',
            status: { in: ['APPROVED', 'SUPERSEDED'] },
            season: { pond: { farm: { ownerId } } },
        },
    });
const normalizeHeader = (row, appliedSeasons) => {
    const { _count, ...header } = row;
    return {
        ...header,
        allowedVariancePct: Number(row.allowedVariancePct),
        usedSeasonCount: appliedSeasons.filter(
            (entry) => entry.sourceTemplateId === row.id
        ).length,
        canDelete: _count.sourcedProtocols === 0,
    };
};
const getTemplates = async ({ managedByOwnerId }, query = {}) => {
    const { page = 1, limit = 10 } = query;
    if (!managedByOwnerId)
        return {
            templates: [],
            meta: { page, limit, totalResults: 0, farms: [] },
        };
    const where = {
        ...scope(managedByOwnerId),
        ...(query.farmId && { farmId: query.farmId }),
        ...(query.shrimpType && { shrimpType: query.shrimpType }),
        ...(query.status && { status: query.status }),
        ...(query.search && {
            OR: ['title', 'description'].map((field) => ({
                [field]: { contains: query.search, mode: 'insensitive' },
            })),
        }),
    };
    const [totalResults, rows, farms] = await Promise.all([
        prisma.productionProtocolTemplate.count({ where }),
        prisma.productionProtocolTemplate.findMany({
            where,
            select: headerSelect,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.farm.findMany({
            where: { ownerId: managedByOwnerId, status: FARM_STATUS.ACTIVE },
            select: { id: true, name: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
    ]);
    const data = rows.length
        ? await applications(
              managedByOwnerId,
              rows.map(({ id }) => id)
          )
        : null;
    return {
        templates: rows.map((row) => normalizeHeader(row, data)),
        meta: { page, limit, totalResults, farms },
    };
};

const normalizeItem = (item, farmId) => {
    const owned = item.product?.farmId === farmId;
    const product = owned
        ? item.product
        : productFromRecommendation(item.recommendedProductDetails);
    return {
        id: item.id,
        operationType: item.operationType,
        startDay: item.startDayOfCulture,
        endDay: item.endDayOfCulture,
        repeatIntervalDays: item.repeatIntervalDays,
        mealNumber: item.mealNumber,
        plannedTime: item.plannedTime?.toISOString().slice(11, 16) ?? null,
        doseBasis: item.doseBasis,
        doseValue: Number(item.doseValue),
        dailyDoseIncrement: Number(item.dailyDoseIncrement ?? 0),
        doseUnit: item.doseUnit,
        instructions: item.instructions,
        product: {
            ...normalizeMaterial(
                product ?? {
                    name: messages.EXPERT_PROTOCOL_TEMPLATE
                        .MATERIAL_UNAVAILABLE,
                    imageUrls: [],
                }
            ),
            ...(!owned && {
                id: undefined,
                manufacturerId: item.recommendedManufacturerId ?? undefined,
            }),
            isRecommendation: !owned && Boolean(product),
            unavailable: Boolean(
                item.productId && (!owned || product.status !== 'ACTIVE')
            ),
        },
    };
};
const readTemplate = async ({ managedByOwnerId }, templateId) => {
    if (!managedByOwnerId) throw notFound();
    const row = await prisma.productionProtocolTemplate.findFirst({
        where: { id: templateId, ...scope(managedByOwnerId) },
        select: {
            ...headerSelect,
            referencePostCount: true,
            updatedAt: true,
            items: {
                include: { product: { select: materialSelect } },
                orderBy: [{ sequenceOrder: 'asc' }, { id: 'asc' }],
            },
        },
    });
    if (!row) throw notFound();
    const { items, ...header } = row;
    return {
        ...normalizeHeader(
            header,
            await applications(managedByOwnerId, [templateId])
        ),
        // Duration belongs to detail/editor responses; the list has no duration column.
        duration: items.length
            ? {
                  startDay: Math.min(
                      ...items.map((item) => item.startDayOfCulture)
                  ),
                  endDay: Math.max(
                      ...items.map((item) => item.endDayOfCulture)
                  ),
              }
            : null,
        farmLocked: row._count.sourcedProtocols > 0,
        items: items.map((item) => normalizeItem(item, row.farm.id)),
    };
};
const getCreationOptions = async ({ managedByOwnerId }) => {
    if (!managedByOwnerId) return { farms: [], manufacturers: [] };
    const [farms, manufacturers] = await Promise.all([
        prisma.farm.findMany({
            where: { ownerId: managedByOwnerId, status: FARM_STATUS.ACTIVE },
            select: { id: true, name: true },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        prisma.supplier.findMany({
            where: {
                ownerId: managedByOwnerId,
                status: 'active',
                supplierType: { in: ['MANUFACTURER', 'BOTH'] },
            },
            select: {
                id: true,
                name: true,
                supplierType: true,
                contactName: true,
                phone: true,
                email: true,
                address: true,
                note: true,
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
    ]);
    return {
        farms,
        manufacturers: manufacturers.map(normalizeManufacturer),
    };
};

/** Stock is informational: templates neither reserve inventory nor use availability as compliance evidence. */
const getMaterials = async (
    { managedByOwnerId },
    { farmId, group = 'ALL', search, page = 1, limit = 5 }
) => {
    const farm =
        managedByOwnerId &&
        (await prisma.farm.findFirst({
            where: { id: farmId, ownerId: managedByOwnerId, status: FARM_STATUS.ACTIVE },
            select: { id: true },
        }));
    if (!farm)
        throw ApiError.notFound(
            messages.EXPERT_PROTOCOL_TEMPLATE.FARM_NOT_FOUND
        );
    const where = {
        farmId,
        status: 'ACTIVE',
        ...(group !== 'ALL' && { category: group }),
        ...(search && {
            OR: [
                ...['name', 'description', 'recommendationReason'].map(
                    (field) => ({
                        [field]: { contains: search, mode: 'insensitive' },
                    })
                ),
                {
                    compliance: {
                        is: {
                            ingredientsText: {
                                contains: search,
                                mode: 'insensitive',
                            },
                        },
                    },
                },
            ],
        }),
    };
    const [totalResults, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
            where,
            select: materialSelect,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);
    const balances = rows.length
        ? await prisma.inventoryBalance.groupBy({
              by: ['productId', 'lotNumber'],
              where: {
                  productId: { in: rows.map(({ id }) => id) },
                  quantity: { gt: 0 },
              },
              _sum: { quantity: true },
          })
        : [];
    // V2 receipt layers may share one manufacturer lot number.
    const stock = new Map();
    for (const balance of balances) {
        const summary = stock.get(balance.productId) ?? {
            quantity: new Prisma.Decimal(0),
            lotCount: 0,
        };
        summary.quantity = summary.quantity.plus(balance._sum.quantity ?? 0);
        summary.lotCount += 1;
        stock.set(balance.productId, summary);
    }
    const manufacturerIds = [
        ...new Set(rows.map((row) => row.manufacturerId).filter(Boolean)),
    ];
    // Resolve only manufacturers belonging to this Owner, including inactive historical contacts.
    const manufacturers = manufacturerIds.length
        ? await prisma.supplier.findMany({
              where: { id: { in: manufacturerIds }, ownerId: managedByOwnerId },
              select: {
                  id: true,
                  name: true,
                  supplierType: true,
                  contactName: true,
                  phone: true,
                  email: true,
                  address: true,
                  note: true,
              },
          })
        : [];
    const manufacturerById = new Map(manufacturers.map((row) => [row.id, row]));
    return {
        materials: rows.map((row) => ({
            ...normalizeMaterial(row),
            manufacturer: normalizeManufacturer(
                manufacturerById.get(row.manufacturerId)
            ),
            stockQuantity: Number(stock.get(row.id)?.quantity ?? 0),
            lotCount: stock.get(row.id)?.lotCount ?? 0,
        })),
        meta: { page, limit, totalResults },
    };
};
const flatten = (stages) =>
    stages.flatMap((stage) => [
        ...stage.meals.flatMap((meal, index) =>
            meal.items.flatMap((item) =>
                applicationRuns(item, stage).map((run) => ({
                    ...item,
                    ...run,
                    // A linear dose remains anchored to the original first application day after compaction.
                    doseValue:
                        item.doseValue +
                        (item.dailyDoseIncrement ?? 0) *
                            (run.startDay - (item.firstDay ?? stage.startDay)),
                    mealNumber: index + 1,
                    time: meal.time,
                    environment: false,
                }))
            )
        ),
        ...stage.environment.map((item) => ({
            ...item,
            startDay: item.firstDay,
            endDay:
                item.repeatIntervalDays == null
                    ? item.firstDay
                    : (item.lastDay ?? stage.endDay),
            repeatIntervalDays: item.repeatIntervalDays ?? 1,
            mealNumber: null,
            environment: true,
        })),
    ]);
const requireExpert = async (tx, account) => {
    const expert = await tx.account.findFirst({
        where: {
            id: account.id,
            role: 'EXPERT',
            status: 'ACTIVE',
            managedByOwnerId: account.managedByOwnerId,
        },
        select: { id: true },
    });
    if (!expert || !account.managedByOwnerId)
        throw ApiError.forbidden(
            messages.EXPERT_PROTOCOL_TEMPLATE.EXPERT_ASSIGNMENT_CHANGED
        );
    return expert;
};
const mapWriteError = (error) => {
    if (['P2034', 'P2003', 'P2002'].includes(error.code))
        throw ApiError.conflict(
            messages.EXPERT_PROTOCOL_TEMPLATE.WRITE_CONFLICT
        );
    throw error;
};

/** Atomically validate scope and version, then replace all rules and proposal snapshots in one serializable transaction. */
const saveTemplate = async (account, body, templateId = null) => {
    if (!account.managedByOwnerId)
        throw ApiError.forbidden(
            messages.EXPERT_PROTOCOL_TEMPLATE.EXPERT_UNASSIGNED
        );
    const entries = flatten(body.stages);
    if (!['WHITELEG', 'BLACK_TIGER'].includes(body.shrimpType))
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.SPECIES_REQUIRED
        );
    if (entries.length > 500)
        throw ApiError.badRequest(messages.EXPERT_PROTOCOL_TEMPLATE.ITEM_LIMIT);
    if (
        entries.some((item) => item.dailyDoseIncrement > 0) &&
        !body.referencePostCount
    )
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.REFERENCE_POST_COUNT_REQUIRED
        );
    const productIds = [
        ...new Set(entries.map((item) => item.productId).filter(Boolean)),
    ];
    const manufacturerIds = [
        ...new Set(
            entries
                .map((item) => item.recommendation?.manufacturerId)
                .filter(Boolean)
        ),
    ];
    try {
        return await prisma.$transaction(
            async (tx) => {
                await requireExpert(tx, account);
                if (templateId) {
                    const existing =
                        await tx.productionProtocolTemplate.findFirst({
                            where: {
                                id: templateId,
                                ...scope(account.managedByOwnerId),
                            },
                            select: {
                                versionNo: true,
                                farmId: true,
                                _count: { select: { sourcedProtocols: true } },
                            },
                        });
                    if (!existing) throw notFound();
                    if (existing.versionNo !== body.expectedVersionNo)
                        throw ApiError.conflict(
                            messages.EXPERT_PROTOCOL_TEMPLATE.STALE_SAVE
                        );
                    if (
                        existing.farmId !== body.farmId &&
                        existing._count.sourcedProtocols > 0
                    )
                        throw ApiError.conflict(
                            messages.EXPERT_PROTOCOL_TEMPLATE
                                .REFERENCED_FARM_LOCKED
                        );
                }
                const farm = await tx.farm.findFirst({
                    where: {
                        id: body.farmId,
                        ownerId: account.managedByOwnerId,
                        status: FARM_STATUS.ACTIVE,
                    },
                    select: { id: true },
                });
                if (!farm)
                    throw ApiError.notFound(
                        messages.EXPERT_PROTOCOL_TEMPLATE.FARM_NOT_FOUND
                    );
                const products = productIds.length
                    ? await tx.product.findMany({
                          where: {
                              id: { in: productIds },
                              farmId: farm.id,
                              status: 'ACTIVE',
                          },
                          select: materialSelect,
                      })
                    : [];
                if (products.length !== productIds.length)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE
                            .MATERIAL_UNAVAILABLE_OR_FOREIGN
                    );
                const manufacturers = manufacturerIds.length
                    ? await tx.supplier.findMany({
                          where: {
                              id: { in: manufacturerIds },
                              ownerId: account.managedByOwnerId,
                              status: 'active',
                              supplierType: { in: ['MANUFACTURER', 'BOTH'] },
                          },
                          select: {
                              id: true,
                              name: true,
                              supplierType: true,
                              contactName: true,
                              phone: true,
                              email: true,
                              address: true,
                              note: true,
                          },
                      })
                    : [];
                if (manufacturers.length !== manufacturerIds.length)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE
                            .MANUFACTURER_UNAVAILABLE_OR_FOREIGN
                    );
                const items = entries.map((entry, index) => {
                    const catalog = products.find(
                        (row) => row.id === entry.productId
                    );
                    const product = entry.productId
                        ? { ...catalog, productCompliance: catalog.compliance }
                        : entry.recommendation;
                    const assessment = entry.recommendation
                        ? assessTemplateProposal(product, account.id)
                        : null;
                    assertMaterialSafety(
                        product,
                        entry.environment,
                        entry.instructions
                    );
                    const operationType = assertTemplateDose(
                        entry,
                        product,
                        entry.startDay,
                        entry.environment
                    );
                    const manufacturer = entry.recommendation?.manufacturerId
                        ? manufacturers.find(
                              (row) =>
                                  row.id === entry.recommendation.manufacturerId
                          )
                        : entry.recommendation?.manufacturer;
                    // Persist lowercase SQL enum values in snapshots while preserving uppercase Prisma product enums in the API.
                    const proposed = entry.recommendation
                        ? {
                              ...entry.recommendation,
                              productCompliance: assessment.productCompliance,
                              manufacturer: manufacturer
                                  ? Object.fromEntries(
                                        Object.entries(
                                            normalizeManufacturer(manufacturer)
                                        ).filter(([field]) => field !== 'id')
                                    )
                                  : null,
                              category: product.category.toLowerCase(),
                              unit: product.unit.toLowerCase(),
                              conversionUnit:
                                  product.conversionUnit?.toLowerCase() ?? null,
                          }
                        : null;
                    if (proposed) delete proposed.manufacturerId;
                    return {
                        productId: entry.productId ?? null,
                        recommendedManufacturerId:
                            entry.recommendation?.manufacturerId ?? null,
                        recommendedProductDetails: proposed
                            ? {
                                  proposed,
                                  ownerOverrides: null,
                                  review: assessment.review,
                              }
                            : Prisma.DbNull,
                        operationType,
                        startDayOfCulture: entry.startDay,
                        endDayOfCulture: entry.endDay,
                        mealNumber: entry.mealNumber,
                        repeatIntervalDays: entry.repeatIntervalDays,
                        plannedTime: new Date(
                            `1970-01-01T${entry.time}:00.000Z`
                        ),
                        doseBasis: entry.doseBasis,
                        doseValue: entry.doseValue,
                        dailyDoseIncrement: entry.dailyDoseIncrement ?? 0,
                        doseUnit: entry.doseUnit,
                        instructions: entry.instructions || null,
                        sequenceOrder: index + 1,
                    };
                });
                const data = {
                    farmId: farm.id,
                    title: body.title,
                    description: body.description || null,
                    shrimpType: body.shrimpType,
                    allowedVariancePct: body.allowedVariancePct,
                    referencePostCount: body.referencePostCount ?? null,
                    status: body.status ?? TemplateStatus.active,
                    updatedAt: new Date(),
                };
                if (templateId) {
                    const changed =
                        await tx.productionProtocolTemplate.updateMany({
                            where: {
                                id: templateId,
                                versionNo: body.expectedVersionNo,
                                ...scope(account.managedByOwnerId),
                            },
                            data: { ...data, versionNo: { increment: 1 } },
                        });
                    if (changed.count !== 1)
                        throw ApiError.conflict(
                            messages.EXPERT_PROTOCOL_TEMPLATE.STALE_SAVE
                        );
                    // Applied protocols own their snapshots; editing a template never rewrites historical schedules or measurements.
                    await tx.productionProtocolTemplateItem.deleteMany({
                        where: { templateId },
                    });
                    await tx.productionProtocolTemplateItem.createMany({
                        data: items.map((item) => ({ ...item, templateId })),
                    });
                    return {
                        id: templateId,
                        title: body.title,
                        versionNo: body.expectedVersionNo + 1,
                    };
                }
                return tx.productionProtocolTemplate.create({
                    data: {
                        ...data,
                        versionNo: 1,
                        createdBy: account.id,
                        items: { createMany: { data: items } },
                    },
                    select: { id: true, title: true, versionNo: true },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
    } catch (error) {
        return mapWriteError(error);
    }
};

/** Hard-delete only unreferenced templates; foreign keys protect against concurrent references. */
const deleteTemplate = async (account, templateId, expectedVersionNo) => {
    if (!account.managedByOwnerId) throw notFound();
    try {
        await prisma.$transaction(
            async (tx) => {
                await requireExpert(tx, account);
                const where = {
                    id: templateId,
                    ...scope(account.managedByOwnerId),
                };
                const row = await tx.productionProtocolTemplate.findFirst({
                    where,
                    select: {
                        versionNo: true,
                        _count: { select: { sourcedProtocols: true } },
                    },
                });
                if (!row) throw notFound();
                if (row.versionNo !== expectedVersionNo)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE.STALE_DELETE
                    );
                if (row._count.sourcedProtocols)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE
                            .REFERENCED_DELETE_BLOCKED
                    );
                await tx.productionProtocolTemplateItem.deleteMany({
                    where: { templateId },
                });
                const changed = await tx.productionProtocolTemplate.deleteMany({
                    where: {
                        ...where,
                        versionNo: expectedVersionNo,
                        sourcedProtocols: { none: {} },
                    },
                });
                if (changed.count !== 1)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE.DELETE_CONFLICT
                    );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
    } catch (error) {
        return mapWriteError(error);
    }
};
/** Change availability without replacing material rules or applied protocols. */
const updateStatus = async (account, templateId, body) => {
    if (!account.managedByOwnerId) throw notFound();
    try {
        return await prisma.$transaction(
            async (tx) => {
                await requireExpert(tx, account);
                const where = {
                    id: templateId,
                    ...scope(account.managedByOwnerId),
                };
                const row = await tx.productionProtocolTemplate.findFirst({
                    where,
                    select: { versionNo: true },
                });
                if (!row) throw notFound();
                if (row.versionNo !== body.expectedVersionNo)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE.STALE_SAVE
                    );
                const result = await tx.productionProtocolTemplate.updateMany({
                    where: { ...where, versionNo: body.expectedVersionNo },
                    data: {
                        status: body.status,
                        versionNo: { increment: 1 },
                        updatedAt: new Date(),
                    },
                });
                if (result.count !== 1)
                    throw ApiError.conflict(
                        messages.EXPERT_PROTOCOL_TEMPLATE.STALE_SAVE
                    );
                return {
                    id: templateId,
                    status: body.status,
                    versionNo: body.expectedVersionNo + 1,
                };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
    } catch (error) {
        return mapWriteError(error);
    }
};
module.exports = {
    updateStatus,
    getTemplates,
    getTemplate: readTemplate,
    getTemplateEditor: readTemplate,
    getCreationOptions,
    getMaterials,
    createTemplate: saveTemplate,
    updateTemplate: (account, body, templateId) => {
        if (!templateId) throw notFound();
        return saveTemplate(account, body, templateId);
    },
    deleteTemplate,
};
