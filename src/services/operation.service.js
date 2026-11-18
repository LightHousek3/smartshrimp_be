const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const config = require('../config');
const { emitNotification } = require('../realtime');
const {
    ApiError,
    stockQuantity,
    vietnamDate,
    assertMaterialSafety,
    protocolStructure: structure,
    productionSchedule: scheduleRules,
} = require('../utils');
const withdrawal = require('./harvestWithdrawal.service');
const {
    materialSelect,
    assertOperationalMaterial,
    assertApprovedMaterial,
} = require('./productionProtocolReview.service');
const lifecycle = require('./protocolLifecycle.service');
const { courseEndsAt } = require('../utils/protocolTimeline');
const { latestHarvestAt } = require('./harvest.service');
const { timingComparison, TIMING } = require('../utils/protocolExecution');
const {
    messages,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    OPERATION_STATUS,
    OPERATION_TYPE,
    NOTIFICATION_TYPE,
    PRODUCTION_PROTOCOL_LIMITS,
    FARM_STATUS,
    PROTOCOL_STATUS,
} = require('../constants');

const toNumber = (val) => (val == null ? null : Number(val));
const ITEM_STORAGE_SELECT = {
    productionMealId: true,
    dailyDoseIncrement: true,
    recurrenceAnchorDay: true,
    doseAnchorDay: true,
    materialSnapshot: true,
};

/**
 * Compute live usable FEFO inventory (receivedAt <= now, expiryDate >= today VN)
 * converted into each schedule's unit so the client can warn and prevent recording
 * whenever any required material is short on stock.
 */
const attachAvailableStock = async (schedules, now = new Date()) => {
    const productIds = [
        ...new Set(schedules.map((s) => s.productId || s.product?.id).filter(Boolean)),
    ];
    const sumByProductId = new Map();
    if (productIds.length > 0) {
        const balances = await prisma.inventoryBalance.groupBy({
            by: ['productId'],
            where: {
                productId: { in: productIds },
                quantity: { gt: 0 },
                receivedAt: { lte: now },
                expiryDate: { gte: vietnamDate(now) },
            },
            _sum: { quantity: true },
        });
        for (const row of balances) {
            sumByProductId.set(row.productId, row._sum.quantity ?? new Prisma.Decimal(0));
        }
    }

    return schedules.map((s) => {
        const productId = s.productId || s.product?.id;
        if (!productId || !s.product) {
            return { ...s, availableStock: null, hasSufficientStock: true };
        }
        const rawStock = new Prisma.Decimal(sumByProductId.get(productId) ?? 0);
        try {
            const requiredInProductUnit = stockQuantity(s.plannedQuantity, s.unit, s.product);
            const hasSufficientStock = rawStock.gte(requiredInProductUnit);
            let availableStock = 0;
            if (rawStock.gt(0)) {
                if (s.unit === s.product.unit) {
                    availableStock = Number(
                        rawStock.toDecimalPlaces(6, Prisma.Decimal.ROUND_FLOOR),
                    );
                } else {
                    const perScheduleUnit = stockQuantity(1, s.unit, s.product);
                    availableStock = Number(
                        rawStock
                            .div(perScheduleUnit)
                            .toDecimalPlaces(6, Prisma.Decimal.ROUND_FLOOR),
                    );
                }
            }
            return { ...s, availableStock, hasSufficientStock };
        } catch {
            return { ...s, availableStock: 0, hasSufficientStock: false };
        }
    });
};

/** Present saved material facts and quantities without exposing internal scheduling metadata. */
const formatSchedule = (s) => {
    if (!s) return s;
    const material = s.protocolItem?.materialSnapshot;
    const publicItem =
        s.protocolItem &&
        Object.fromEntries(
            Object.entries(s.protocolItem).filter(
                ([key]) => !Object.hasOwn(ITEM_STORAGE_SELECT, key),
            ),
        );
    const formattedProduct = s.product
        ? {
              ...s.product,
              ...(material &&
                  material.id === s.product.id && {
                      name: material.name,
                      category: material.category,
                      unit: material.unit,
                  }),
              ...(s.product.compliance && {
                  compliance: {
                      ...s.product.compliance,
                      withdrawalDays: toNumber(s.product.compliance.withdrawalDays),
                  },
              }),
          }
        : s.product;
    return {
        ...s,
        product: formattedProduct,
        plannedQuantity: toNumber(s.plannedQuantity),
        doseValueSnapshot: toNumber(s.doseValueSnapshot),
        basisQuantity: toNumber(s.basisQuantity),
        protocolItem: s.protocolItem
            ? {
                  ...publicItem,
                  protocol: s.protocolItem.protocol
                      ? {
                            ...s.protocolItem.protocol,
                            allowedVariancePct: toNumber(
                                s.protocolItem.protocol.allowedVariancePct,
                            ),
                        }
                      : s.protocolItem.protocol,
              }
            : s.protocolItem,
        execution: s.execution
            ? {
                  ...s.execution,
                  actualQuantity: toNumber(s.execution.actualQuantity),
              }
            : s.execution,
        sourceHealthLog: s.sourceHealthLog
            ? {
                  ...s.sourceHealthLog,
                  estimatedBiomassKg: toNumber(s.sourceHealthLog.estimatedBiomassKg),
                  avgWeightG: toNumber(s.sourceHealthLog.avgWeightG),
              }
            : s.sourceHealthLog,
    };
};

/**
 * List operation schedules for an assigned technician across a rolling 3-day calendar window.
 * Enforces technician assignment to an active season and returns contextual progress summaries.
 */
const listSchedules = async (technicianId, seasonId, query = {}) => {
    const assignment = await prisma.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId,
            accountId: technicianId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
        },
    });
    if (!assignment) {
        throw ApiError.forbidden(messages.OPERATION.NOT_ASSIGNED_TECHNICIAN);
    }

    const season = await prisma.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: {
            id: true,
            name: true,
            status: true,
            pond: {
                select: {
                    id: true,
                    name: true,
                    farm: { select: { id: true, name: true } },
                },
            },
        },
    });
    if (!season) {
        throw ApiError.notFound('Không tìm thấy vụ nuôi');
    }

    // Match the generator's freshness policy; future/voided measurements cannot authorize a dose.
    const now = new Date();
    const freshSince = new Date(
        now.getTime() - PRODUCTION_PROTOCOL_LIMITS.biomassMaxAgeHours * 3600000,
    );
    const recentBiomassLog = await prisma.shrimpHealthLog.findFirst({
        where: {
            seasonId,
            isVoided: false,
            estimatedBiomassKg: { gt: 0 },
            recordedAt: { gte: freshSince, lte: now },
        },
        select: { id: true, estimatedBiomassKg: true, recordedAt: true },
        orderBy: { recordedAt: 'desc' },
    });
    const hasBiomassWarning = !recentBiomassLog;
    const biomassWarningMessage = hasBiomassWarning
        ? messages.PRODUCTION_PROTOCOL.BIOMASS_WARNING
        : null;

    const counts = await prisma.operationSchedule.groupBy({
        by: ['status'],
        where: query.date ? { seasonId, scheduledAt: { gte: new Date(query.date + 'T00:00:00+07:00'), lte: new Date(query.date + 'T23:59:59.999+07:00') } } : { seasonId },
        _count: { _all: true },
    });
    const statusMap = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    const plannedCount = statusMap[OPERATION_STATUS.PLANNED] || 0;
    const completedCount = statusMap[OPERATION_STATUS.COMPLETED] || 0;
    const cancelledCount = statusMap[OPERATION_STATUS.CANCELLED] || 0;

    const where = {
        seasonId,
        ...(query.status && { status: query.status }),
        ...(query.operationType && { operationType: query.operationType }),
    };

    if (query.date) {
        const start = new Date(`${query.date}T00:00:00+07:00`);
        const end = new Date(`${query.date}T23:59:59.999+07:00`);
        where.scheduledAt = { gte: start, lte: end };
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const skip = (page - 1) * limit;

    const [schedules, total] = await Promise.all([
        prisma.operationSchedule.findMany({
            where,
            select: {
                id: true,
                seasonId: true,
                protocolItemId: true,
                operationType: true,
                scheduledAt: true,
                plannedQuantity: true,
                unit: true,
                doseBasisSnapshot: true,
                doseValueSnapshot: true,
                basisQuantity: true,
                basisUnit: true,
                calculationVersion: true,
                status: true,
                cancellationType: true,
                cancellationReason: true,
                cancelledAt: true,
                season: {
                    select: {
                        id: true,
                        name: true,
                        pond: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                product: {
                    select: {
                        id: true,
                        name: true,
                        category: true,
                        unit: true,
                        conversionUnit: true,
                        conversionQuantity: true,
                        imageUrls: true,
                        compliance: {
                            select: {
                                withdrawalDays: true,
                                usageInstructions: true,
                            },
                        },
                    },
                },
                protocolItem: {
                    select: {
                        id: true,
                        mealNumber: true,
                        plannedTime: true,
                        dueAtMinutes: true,
                        instructions: true,
                        ...ITEM_STORAGE_SELECT,
                        protocol: {
                            select: {
                                id: true,
                                title: true,
                                versionNo: true,
                                allowedVariancePct: true,
                            },
                        },
                    },
                },
                execution: {
                    select: {
                        id: true,
                        actualQuantity: true,
                        executedAt: true,
                        note: true,
                        varianceReason: true,
                        actualProduct: {
                            select: { id: true, name: true, unit: true },
                        },
                    },
                },
            },
            orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
            skip,
            take: limit,
        }),
        prisma.operationSchedule.count({ where }),
    ]);

    const schedulesWithStock = await attachAvailableStock(schedules, now);
    const formattedSchedules = schedulesWithStock.map(formatSchedule);

    return {
        season,
        summary: {
            planned: plannedCount,
            completed: completedCount,
            cancelled: cancelledCount,
            total: plannedCount + completedCount + cancelledCount,
        },
        banner: {
            hasBiomassWarning,
            message: biomassWarningMessage,
        },
        schedules: formattedSchedules,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
};

/**
 * Retrieve schedule details with calculation inputs, product compliance, and execution status.
 */
const getSchedule = async (technicianId, scheduleId) => {
    const schedule = await prisma.operationSchedule.findUnique({
        where: { id: scheduleId },
        include: {
            product: {
                select: {
                    id: true,
                    name: true,
                    category: true,
                    unit: true,
                    conversionUnit: true,
                    conversionQuantity: true,
                    imageUrls: true,
                    compliance: {
                        select: {
                            withdrawalDays: true,
                            usageInstructions: true,
                        },
                    },
                },
            },
            protocolItem: {
                select: {
                    id: true,
                    protocolId: true,
                    operationType: true,
                    productId: true,
                    startDayOffset: true,
                    endDayOffset: true,
                    repeatIntervalDays: true,
                    mealNumber: true,
                    plannedTime: true,
                    dueAtMinutes: true,
                    doseBasis: true,
                    doseValue: true,
                    doseUnit: true,
                    instructions: true,
                    sequenceOrder: true,
                    recommendedProductDetails: true,
                    recommendedManufacturerId: true,
                    ...ITEM_STORAGE_SELECT,
                    createdAt: true,
                    updatedAt: true,
                    protocol: {
                        select: {
                            id: true,
                            title: true,
                            versionNo: true,
                            allowedVariancePct: true,
                            protocolType: true,
                        },
                    },
                },
            },
            season: {
                select: {
                    id: true,
                    name: true,
                    status: true,
                    pond: {
                        select: {
                            id: true,
                            name: true,
                            farm: { select: { id: true, name: true } },
                        },
                    },
                },
            },
            execution: {
                include: {
                    actualProduct: {
                        select: { id: true, name: true, unit: true },
                    },
                },
            },
            sourceHealthLog: {
                select: {
                    id: true,
                    recordedAt: true,
                    estimatedBiomassKg: true,
                    avgWeightG: true,
                },
            },
            cancelledByAccount: {
                select: { id: true, fullName: true, email: true },
            },
        },
    });

    if (!schedule) {
        throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    }

    // Verify technician active assignment for this season
    const assignment = await prisma.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId: schedule.seasonId,
            accountId: technicianId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
        },
    });
    if (!assignment) {
        throw ApiError.forbidden(messages.OPERATION.NOT_ASSIGNED_TECHNICIAN);
    }

    const [scheduleWithStock] = await attachAvailableStock([schedule]);
    return formatSchedule(scheduleWithStock);
};

/** Persist shortage alerts after the failed execution rolls back; serialize retries by schedule. */
const notifyInsufficientInventory = async (technicianId, scheduleId) => {
    const notices = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM operation_schedules WHERE id = ${scheduleId}::uuid FOR UPDATE`;
        const schedule = await tx.operationSchedule.findUnique({
            where: { id: scheduleId },
            select: {
                season: { select: { pond: { select: { farm: { select: { ownerId: true } } } } } },
            },
        });
        if (!schedule) return [];
        const ownerId = schedule.season.pond.farm.ownerId;
        const saved = [];
        for (const accountId of new Set([ownerId, technicianId])) {
            const where = {
                accountId,
                type: NOTIFICATION_TYPE.INVENTORY_INSUFFICIENT,
                referenceType: 'operation_schedule',
                referenceId: scheduleId,
            };
            // A planned occurrence needs one shortage alert per recipient, even when the request is retried.
            if (await tx.notification.findFirst({ where, select: { id: true } })) continue;
            saved.push(
                await tx.notification.create({
                    data: {
                        ...where,
                        title: messages.OPERATION.INSUFFICIENT_INVENTORY_TITLE,
                        content: messages.OPERATION.INSUFFICIENT_INVENTORY_CONTENT,
                    },
                    select: { id: true, accountId: true },
                }),
            );
        }
        return saved;
    });
    for (const notice of notices) {
        emitNotification(notice.accountId, 'notification:new', {
            id: notice.id,
            referenceId: scheduleId,
        });
    }
};

/**
 * Execute one planned schedule inside an already-locked Serializable transaction.
 * Caller holds the season row lock and has reconciled protocol lifecycle state.
 */
const executeScheduleInTx = async (
    tx,
    technicianId,
    scheduleId,
    payload,
    actual,
    notifications,
    { skipScheduleLock = false, skipReconcileAfter = false } = {},
) => {
    if (!skipScheduleLock) {
        await tx.$queryRaw`SELECT id FROM operation_schedules WHERE id = ${scheduleId}::uuid FOR UPDATE`;
    }
    const schedule = await tx.operationSchedule.findUnique({
        where: { id: scheduleId },
        include: {
            season: {
                include: {
                    pond: {
                        select: {
                            farmId: true,
                            farm: { select: { ownerId: true, status: true } },
                        },
                    },
                },
            },
            protocolItem: {
                select: {
                    ...ITEM_STORAGE_SELECT,
                    operationType: true,
                    doseBasis: true,
                    doseValue: true,
                    doseUnit: true,
                    startDayOffset: true,
                    endDayOffset: true,
                    repeatIntervalDays: true,
                    mealNumber: true,
                    instructions: true,
                    dueAtMinutes: true,
                    protocol: {
                        select: {
                            id: true,
                            allowedVariancePct: true,
                            protocolType: true,
                            diseaseCaseId: true,
                            status: true,
                            treatmentStartAt: true,
                            items: true,
                        },
                    },
                },
            },
        },
    });
    if (!schedule) throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    const assignment = await tx.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId: schedule.seasonId,
            accountId: technicianId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
            account: {
                role: 'TECHNICIAN',
                status: 'ACTIVE',
                managedByOwnerId: schedule.season.pond.farm.ownerId,
            },
        },
        select: { id: true },
    });
    if (!assignment) throw ApiError.forbidden(messages.OPERATION.NOT_ASSIGNED_TECHNICIAN);
    const targetProductId = payload.actualProductId || schedule.productId;
    if (!targetProductId)
        throw ApiError.badRequest(messages.HARVEST.WITHDRAWAL_PRODUCT_NOT_READY);
    const existing = await tx.operationExecution.findUnique({
        where: { idempotencyKey: payload.idempotencyKey },
        include: {
            actualProduct: { select: { id: true, name: true, unit: true } },
        },
    });
    if (existing) {
        if (
            existing.scheduleId !== scheduleId ||
            existing.executedBy !== technicianId ||
            existing.actualProductId !== targetProductId ||
            !actual.equals(existing.actualQuantity) ||
            (payload.executedAt &&
                existing.executedAt.getTime() !== new Date(payload.executedAt).getTime()) ||
            (existing.note || null) !== (payload.note || null) ||
            (existing.varianceReason || null) !== (payload.varianceReason || null)
        ) {
            throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
        }
        return { ...existing, actualQuantity: Number(existing.actualQuantity) };
    }
    if (schedule.season.status !== SEASON_STATUS.ACTIVE)
        throw ApiError.badRequest(messages.OPERATION.SEASON_NOT_ACTIVE);
    if (schedule.status !== OPERATION_STATUS.PLANNED)
        throw ApiError.conflict(messages.OPERATION.SCHEDULE_NOT_PLANNED);
    const now = new Date();
    const executedAt = payload.executedAt ? new Date(payload.executedAt) : now;
    if (now < schedule.scheduledAt || executedAt < schedule.scheduledAt) {
        throw ApiError.badRequest(messages.OPERATION.EARLY_EXECUTION_NOT_ALLOWED);
    }
    const protocol = schedule.protocolItem.protocol;
    const end = courseEndsAt({ ...protocol, season: schedule.season });
    const replacementStart = await lifecycle.nextTreatmentStart(
        tx,
        schedule.seasonId,
        protocol.id,
    );
    if (replacementStart && new Date() >= replacementStart)
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.REPLACEMENT_DUE);
    if (!end || new Date() > end) {
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.RECORDING_CLOSED);
    }
    const approvedMaterial = schedule.protocolItem.materialSnapshot;
    if (
        protocol.protocolType === 'TREATMENT' &&
        !(await tx.diseaseCase.count({
            where: {
                id: protocol.diseaseCaseId,
                seasonId: schedule.seasonId,
                status: 'IN_TREATMENT',
            },
        }))
    )
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.STATE);
    if (
        protocol.protocolType === 'PRODUCTION' &&
        (await lifecycle.productionBlocked(tx, schedule.seasonId))
    ) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
    }
    structure.assertItemMetadata(schedule.protocolItem);
    if (!approvedMaterial || targetProductId !== schedule.productId)
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.MATERIAL_LOCKED);
    if (
        protocol.status !== PROTOCOL_STATUS.ACTIVE ||
        schedule.season.pond.farm.status !== FARM_STATUS.ACTIVE
    ) {
        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
    }
    if (
        ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(
            schedule.doseBasisSnapshot ?? schedule.protocolItem.doseBasis,
        )
    ) {
        // A row lock also detects a void committed after this Serializable snapshot began.
        if (schedule.sourceHealthLogId) {
            await tx.$queryRaw`SELECT id FROM shrimp_health_logs WHERE id = ${schedule.sourceHealthLogId}::uuid AND season_id = ${schedule.seasonId}::uuid FOR SHARE`;
        }
        const evidence = await tx.shrimpHealthLog.findMany({
            where: {
                seasonId: schedule.seasonId,
                isVoided: false,
                recordedAt: { lte: schedule.scheduledAt },
                createdAt: { lte: schedule.scheduledAt },
            },
        });
        // The season lock serializes this check with source voiding and schedule generation.
        // Source freshness follows the scheduled occurrence while the protocol remains effective.
        const harvestedAt = await latestHarvestAt(tx, schedule.seasonId, executedAt);
        const source = scheduleRules.biomassAt(
            evidence,
            schedule.scheduledAt,
            now,
            config.productionProtocol.biomassMaxAgeHours,
            harvestedAt,
        );
        if (!source || source.id !== schedule.sourceHealthLogId) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.BIOMASS_SOURCE_INVALID);
        }
    }
    const planned = new Prisma.Decimal(schedule.plannedQuantity);
    const variance = actual.minus(planned).abs().div(planned).mul(100);
    if (variance.gt(0) && !payload.varianceReason?.trim()) {
        throw ApiError.badRequest(messages.OPERATION.VARIANCE_REASON_REQUIRED);
    }
    const days = await withdrawal.prepareExecution(
        tx,
        schedule.seasonId,
        targetProductId,
        schedule.operationType,
        executedAt,
        protocol,
    );
    const executionId = crypto.randomUUID();
    if (targetProductId) {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${targetProductId}::uuid FOR UPDATE`;
        const product = await tx.product.findFirst({
            where: { id: targetProductId, farmId: schedule.season.pond.farmId },
            ...(approvedMaterial
                ? { select: { ...materialSelect, minAlertQuantity: true } }
                : { include: { compliance: true } }),
        });
        if (!product)
            throw ApiError.badRequest(messages.HARVEST.WITHDRAWAL_PRODUCT_NOT_READY);
        if (product.status !== 'ACTIVE')
            throw ApiError.badRequest(messages.HARVEST.WITHDRAWAL_PRODUCT_NOT_READY);
        if (approvedMaterial) {
            assertOperationalMaterial(
                product,
                schedule.protocolItem,
                schedule.season.pond.farmId,
                schedule.season.pond.farm.ownerId,
                { ...protocol, season: schedule.season },
            );
            assertApprovedMaterial(product, approvedMaterial);
        } else {
            assertMaterialSafety(
                { ...product, productCompliance: product.compliance },
                schedule.operationType !== OPERATION_TYPE.FEEDING,
                null,
                { production: protocol?.protocolType !== 'TREATMENT' },
            );
        }
        const requested = stockQuantity(actual, schedule.unit, product);
        const balances = await tx.inventoryBalance.findMany({
            where: {
                productId: targetProductId,
                quantity: { gt: 0 },
                receivedAt: { lte: executedAt },
                expiryDate: { gte: vietnamDate(executedAt) },
            },
            orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
        });
        const available = balances.reduce(
            (total, balance) => total.add(balance.quantity),
            new Prisma.Decimal(0),
        );
        if (available.lt(requested)) {
            const productLabel = approvedMaterial?.name || product.name;
            const err = ApiError.badRequest(
                productLabel
                    ? `${messages.OPERATION.INSUFFICIENT_INVENTORY} (${productLabel})`
                    : messages.OPERATION.INSUFFICIENT_INVENTORY,
            );
            err.insufficientScheduleId = scheduleId;
            throw err;
        }
        let remaining = requested;
        const groupId = crypto.randomUUID();
        for (const balance of balances) {
            if (remaining.lte(0)) break;
            const deduction = Prisma.Decimal.min(remaining, balance.quantity);
            const changed = await tx.inventoryBalance.updateMany({
                where: {
                    id: balance.id,
                    productId: targetProductId,
                    quantity: { gte: deduction },
                },
                data: { quantity: { decrement: deduction } },
            });
            if (changed.count !== 1)
                throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
            await tx.inventoryTransaction.create({
                data: {
                    transactionGroupId: groupId,
                    productId: targetProductId,
                    inventoryBalanceId: balance.id,
                    seasonId: schedule.seasonId,
                    transactionType: 'STOCK_OUT',
                    quantity: deduction,
                    unitSnapshot: product.unit,
                    totalAmount: deduction.mul(balance.unitPrice).toDecimalPlaces(2),
                    referenceType: 'operation_execution',
                    referenceId: executionId,
                    reason: 'Xuất kho vận hành ao nuôi',
                    performedBy: technicianId,
                    idempotencyKey: crypto.randomUUID(),
                },
            });
            remaining = remaining.minus(deduction);
        }
        notifications.push(
            ...(await require('./inventory.service').notifyStockChange(tx, product, {
                seasonIds: [schedule.seasonId],
            })),
        );
    }
    // Processing may wait on stock locks; a backdated payload never extends the live plan.
    if (end && new Date() > end)
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.RECORDING_CLOSED);
    if (replacementStart && new Date() >= replacementStart)
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.REPLACEMENT_DUE);
    const execution = await tx.operationExecution.create({
        data: {
            id: executionId,
            scheduleId,
            actualProductId: targetProductId,
            actualQuantity: actual,
            withdrawalDaysSnapshot: days,
            executedBy: technicianId,
            idempotencyKey: payload.idempotencyKey,
            executedAt,
            note: payload.note || null,
            varianceReason: payload.varianceReason || null,
        },
        include: {
            actualProduct: { select: { id: true, name: true, unit: true } },
        },
    });
    const completed = await tx.operationSchedule.updateMany({
        where: { id: scheduleId, status: 'PLANNED' },
        data: { status: 'COMPLETED' },
    });
    if (completed.count !== 1) throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
    if (!skipReconcileAfter) {
        notifications.push(...(await lifecycle.reconcile(tx, schedule.seasonId)));
    }
    return { ...execution, actualQuantity: Number(execution.actualQuantity) };
};

/**
 * Record an authorized planned slot and its FEFO stock deductions in one serializable transaction.
 * Reconcile lifecycle state before accepting new usage; an older executedAt cannot reopen a closed course.
 * A matching idempotent retry returns the saved execution without a second stock deduction.
 */
const executeSchedule = async (technicianId, scheduleId, payload) => {
    const pointer = await prisma.operationSchedule.findUnique({
        where: { id: scheduleId },
        select: { seasonId: true },
    });
    if (!pointer) throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    const actual = new Prisma.Decimal(payload.actualQuantity);
    if (!actual.isFinite() || actual.lte(0) || actual.decimalPlaces() > 9) {
        throw ApiError.badRequest('Số lượng thực tế phải dương và tối đa 9 số thập phân');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const notifications = [];
            const result = await prisma.$transaction(
                async (tx) => {
                    // Shared order with harvest: season -> schedule -> actual product -> receipt layers.
                    await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${pointer.seasonId}::uuid FOR UPDATE`;
                    // A delayed worker must not leave a superseded production slot executable.
                    notifications.push(...(await lifecycle.reconcile(tx, pointer.seasonId)));
                    return executeScheduleInTx(
                        tx,
                        technicianId,
                        scheduleId,
                        payload,
                        actual,
                        notifications,
                    );
                },
                {
                    isolationLevel: 'Serializable',
                    maxWait: 5000,
                    timeout: config.productionProtocol.transactionTimeoutMs,
                },
            );
            for (const notification of notifications) {
                try {
                    emitNotification(notification.accountId, 'notification:new', {
                        id: notification.id,
                    });
                } catch {
                    // The execution and persisted notices remain committed if socket delivery fails.
                }
            }
            return result;
        } catch (error) {
            const retryable =
                error.code === 'P2034' ||
                (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
            if (retryable && attempt < 2) continue;
            if (retryable || ['P2002', 'P2028'].includes(error.code))
                throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
            if (
                error instanceof ApiError &&
                (error.insufficientScheduleId ||
                    error.message === messages.OPERATION.INSUFFICIENT_INVENTORY)
            ) {
                await notifyInsufficientInventory(
                    technicianId,
                    error.insufficientScheduleId || scheduleId,
                );
            }
            throw error;
        }
    }
    throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
};

/**
 * Record multiple planned slots (e.g. feeding + mixed medicine in one meal) atomically in a single
 * Serializable transaction. If any item fails (such as insufficient inventory), ALL stock deductions
 * and status updates in the batch roll back together.
 */
const executeSchedulesBatch = async (technicianId, items) => {
    if (!Array.isArray(items) || items.length === 0) {
        throw ApiError.badRequest('Danh sách lịch vận hành cần ghi nhận không được rỗng');
    }
    const scheduleIds = items.map((item) => item.scheduleId);
    if (new Set(scheduleIds).size !== scheduleIds.length) {
        throw ApiError.badRequest('Danh sách ghi nhận chứa lịch vận hành bị trùng lặp');
    }
    const parsedItems = items.map((item) => {
        const actual = new Prisma.Decimal(item.actualQuantity);
        if (!actual.isFinite() || actual.lte(0) || actual.decimalPlaces() > 9) {
            throw ApiError.badRequest('Số lượng thực tế phải dương và tối đa 9 số thập phân');
        }
        return { ...item, actual };
    });

    const pointers = await prisma.operationSchedule.findMany({
        where: { id: { in: scheduleIds } },
        select: { id: true, seasonId: true },
    });
    if (pointers.length !== scheduleIds.length) {
        throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    }
    const seasonIds = new Set(pointers.map((p) => p.seasonId));
    if (seasonIds.size !== 1) {
        throw ApiError.badRequest('Các lịch ghi nhận cùng lúc phải thuộc cùng một vụ nuôi');
    }
    const [seasonId] = seasonIds;
    const sortedScheduleIds = [...scheduleIds].sort();

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const notifications = [];
            const results = await prisma.$transaction(
                async (tx) => {
                    await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
                    notifications.push(...(await lifecycle.reconcile(tx, seasonId)));
                    await tx.$queryRaw(
                        Prisma.sql`SELECT id FROM operation_schedules WHERE id IN (${Prisma.join(
                            sortedScheduleIds.map((id) => Prisma.sql`${id}::uuid`),
                        )}) ORDER BY id FOR UPDATE`,
                    );
                    const executed = [];
                    for (const item of parsedItems) {
                        executed.push(
                            await executeScheduleInTx(
                                tx,
                                technicianId,
                                item.scheduleId,
                                item,
                                item.actual,
                                notifications,
                                { skipScheduleLock: true, skipReconcileAfter: true },
                            ),
                        );
                    }
                    notifications.push(...(await lifecycle.reconcile(tx, seasonId)));
                    return executed;
                },
                {
                    isolationLevel: 'Serializable',
                    maxWait: 5000,
                    timeout: config.productionProtocol.transactionTimeoutMs,
                },
            );
            for (const notification of notifications) {
                try {
                    emitNotification(notification.accountId, 'notification:new', {
                        id: notification.id,
                    });
                } catch {
                    // The executions and persisted notices remain committed if socket delivery fails.
                }
            }
            return results;
        } catch (error) {
            const retryable =
                error.code === 'P2034' ||
                (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
            if (retryable && attempt < 2) continue;
            if (retryable || ['P2002', 'P2028'].includes(error.code))
                throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
            if (
                error instanceof ApiError &&
                (error.insufficientScheduleId ||
                    error.message === messages.OPERATION.INSUFFICIENT_INVENTORY)
            ) {
                if (error.insufficientScheduleId) {
                    await notifyInsufficientInventory(technicianId, error.insufficientScheduleId);
                }
            }
            throw error;
        }
    }
    throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
};

/**
 * Aggregate operational progress and compliance metrics by category and schedule status.
 */
const getSeasonStats = async (technicianId, seasonId) => {
    const assignment = await prisma.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId,
            accountId: technicianId,
            role: PERSONNEL_ROLE.TECHNICIAN,
            unassignedAt: null,
        },
    });
    if (!assignment) {
        throw ApiError.forbidden(messages.OPERATION.NOT_ASSIGNED_TECHNICIAN);
    }

    const now = new Date();

    const counts = await prisma.operationSchedule.groupBy({
        by: ['status'],
        where: { seasonId },
        _count: { _all: true },
    });
    const statusMap = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
    const planned = statusMap[OPERATION_STATUS.PLANNED] || 0;
    const completed = statusMap[OPERATION_STATUS.COMPLETED] || 0;
    const cancelled = statusMap[OPERATION_STATUS.CANCELLED] || 0;
    const total = planned + completed + cancelled;

    const pending = await prisma.operationSchedule.findMany({
        where: {
            seasonId,
            status: OPERATION_STATUS.PLANNED,
            scheduledAt: { lt: now },
            protocolItem: { protocol: { status: 'ACTIVE' } },
        },
        select: {
            scheduledAt: true,
            status: true,
            protocolItem: { select: { dueAtMinutes: true } },
        },
    });

    const overdue = pending.filter(
        (row) =>
            timingComparison(row, row.protocolItem.dueAtMinutes, now).status === TIMING.OVERDUE,
    ).length;

    // Grouping by operationType and status
    const typeGroups = await prisma.operationSchedule.groupBy({
        by: ['operationType', 'status'],
        where: { seasonId },
        _count: { id: true },
    });

    const byType = {};
    for (const type of Object.values(OPERATION_TYPE)) {
        byType[type.toLowerCase()] = {
            total: 0,
            planned: 0,
            completed: 0,
            cancelled: 0,
        };
    }

    for (const group of typeGroups) {
        const typeKey = group.operationType.toLowerCase();
        const statusKey = group.status.toLowerCase();
        if (!byType[typeKey]) {
            byType[typeKey] = { total: 0, planned: 0, completed: 0, cancelled: 0 };
        }
        byType[typeKey][statusKey] = group._count.id;
        byType[typeKey].total += group._count.id;
    }

    const activeTotal = total - cancelled;
    const completionRate =
        activeTotal > 0 ? Number(((completed / activeTotal) * 100).toFixed(2)) : 0;

    return {
        total,
        planned,
        completed,
        cancelled,
        overdue,
        completionRate,
        byType,
    };
};

module.exports = {
    listSchedules,
    getSchedule,
    executeSchedule,
    executeSchedulesBatch,
    getSeasonStats,
};
