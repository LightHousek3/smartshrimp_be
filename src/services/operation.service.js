const crypto = require('crypto');
const prisma = require('../config/prisma');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const {
    messages,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    OPERATION_STATUS,
    OPERATION_TYPE,
    NOTIFICATION_TYPE,
} = require('../constants');

const toNumber = (val) => (val == null ? null : Number(val));

const formatSchedule = (s) => {
    if (!s) return s;
    return {
        ...s,
        plannedQuantity: toNumber(s.plannedQuantity),
        doseValueSnapshot: toNumber(s.doseValueSnapshot),
        basisQuantity: toNumber(s.basisQuantity),
        protocolItem: s.protocolItem ? {
            ...s.protocolItem,
            protocol: s.protocolItem.protocol ? {
                ...s.protocolItem.protocol,
                allowedVariancePct: toNumber(s.protocolItem.protocol.allowedVariancePct),
            } : s.protocolItem.protocol,
        } : s.protocolItem,
        execution: s.execution ? {
            ...s.execution,
            actualQuantity: toNumber(s.execution.actualQuantity),
        } : s.execution,
        sourceHealthLog: s.sourceHealthLog ? {
            ...s.sourceHealthLog,
            estimatedBiomassKg: toNumber(s.sourceHealthLog.estimatedBiomassKg),
            avgWeightG: toNumber(s.sourceHealthLog.avgWeightG),
        } : s.sourceHealthLog,
    };
};

/**
 * UC-09: Xem danh sách kế hoạch vận hành
 */
const listSchedules = async (technicianId, seasonId, query = {}) => {
    // 1. Verify active technician assignment
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

    // 2. Verify season existence
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

    // 3. Biomass health check for warning banner (within 3 days)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const recentBiomassLog = await prisma.shrimpHealthLog.findFirst({
        where: {
            seasonId,
            isVoided: false,
            estimatedBiomassKg: { not: null },
            recordedAt: { gte: threeDaysAgo },
        },
        select: { id: true, estimatedBiomassKg: true, recordedAt: true },
        orderBy: { recordedAt: 'desc' },
    });
    const hasBiomassWarning = !recentBiomassLog;
    const biomassWarningMessage = hasBiomassWarning
        ? 'Chưa có bản ghi sinh khối hợp lệ trong 3 ngày — không thể tính liều theo % sinh khối.'
        : null;

    // 4. Overall stats summary for top tabs / header
    const [plannedCount, completedCount, cancelledCount] = await Promise.all([
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.PLANNED } }),
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.COMPLETED } }),
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.CANCELLED } }),
    ]);

    // 5. Build filter
    const where = {
        seasonId,
        ...(query.status && { status: query.status }),
        ...(query.operationType && { operationType: query.operationType }),
    };

    if (query.date) {
        const start = new Date(`${query.date}T00:00:00.000Z`);
        const end = new Date(`${query.date}T23:59:59.999Z`);
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
                    },
                },
                protocolItem: {
                    select: {
                        id: true,
                        mealNumber: true,
                        plannedTime: true,
                        instructions: true,
                        recommendedProductName: true,
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
            orderBy: [{ scheduledAt: 'asc' }, { generatedAt: 'asc' }],
            skip,
            take: limit,
        }),
        prisma.operationSchedule.count({ where }),
    ]);

    const formattedSchedules = schedules.map(formatSchedule);

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
 * UC-10: Xem chi tiết kế hoạch vận hành
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
                },
            },
            protocolItem: {
                include: {
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

    return formatSchedule(schedule);
};

/**
 * UC-11: Ghi nhận thực hiện hoạt động
 */
const executeSchedule = async (technicianId, scheduleId, payload) => {
    // 1. Fetch schedule
    const schedule = await prisma.operationSchedule.findUnique({
        where: { id: scheduleId },
        include: {
            season: true,
            protocolItem: { include: { protocol: true } },
            product: true,
        },
    });

    if (!schedule) {
        throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    }

    // 2. Verify technician assignment
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

    // 3. BR-OPS-01: Season must be ACTIVE
    if (schedule.season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.badRequest(messages.OPERATION.SEASON_NOT_ACTIVE);
    }

    // 4. Idempotency check: if key already exists, return existing execution
    if (payload.idempotencyKey) {
        const existingExecution = await prisma.operationExecution.findUnique({
            where: { idempotencyKey: payload.idempotencyKey },
            include: {
                actualProduct: { select: { id: true, name: true, unit: true } },
            },
        });
        if (existingExecution) {
            return existingExecution;
        }
    }

    // 5. BR-OPS-03: Only PLANNED schedules can be executed
    if (schedule.status !== OPERATION_STATUS.PLANNED) {
        throw ApiError.conflict(messages.OPERATION.SCHEDULE_NOT_PLANNED);
    }

    // 6. BR-OPS-04: Variance check
    const plannedQty = Number(schedule.plannedQuantity);
    const actualQty = Number(payload.actualQuantity);
    const allowedVariancePct = schedule.protocolItem?.protocol?.allowedVariancePct != null
        ? Number(schedule.protocolItem.protocol.allowedVariancePct)
        : 10;

    const variancePct = plannedQty > 0 ? (Math.abs(actualQty - plannedQty) / plannedQty) * 100 : 0;
    if (variancePct > allowedVariancePct && (!payload.varianceReason || payload.varianceReason.trim() === '')) {
        throw ApiError.badRequest(messages.OPERATION.VARIANCE_REASON_REQUIRED);
    }

    // 7. Atomic transaction: FIFO inventory deduction + execution record + schedule completion
    const targetProductId = payload.actualProductId || schedule.productId;

    // Check inventory availability before transaction so notification is persistent if insufficient
    if (targetProductId) {
        const initialBalances = await prisma.inventoryBalance.findMany({
            where: {
                productId: targetProductId,
                quantity: { gt: 0 },
            },
            select: { quantity: true },
        });

        const totalAvailable = initialBalances.reduce((sum, b) => sum + Number(b.quantity), 0);
        if (totalAvailable < actualQty) {
            const notif = await prisma.notification.create({
                data: {
                    accountId: technicianId,
                    title: 'Tồn kho không đủ để thực hiện vận hành',
                    content: `Không đủ tồn kho cho sản phẩm. Cần ${actualQty}, hiện có ${totalAvailable}.`,
                    type: NOTIFICATION_TYPE.INVENTORY_INSUFFICIENT,
                    referenceType: 'operation_schedule',
                    referenceId: schedule.id,
                },
            });
            emitNotification(technicianId, 'notification:new', {
                id: notif?.id,
                referenceId: schedule.id,
            });
            throw ApiError.badRequest(messages.OPERATION.INSUFFICIENT_INVENTORY);
        }
    }

    return await prisma.$transaction(async (tx) => {
        // Re-check schedule status in transaction
        const freshSchedule = await tx.operationSchedule.findUnique({
            where: { id: scheduleId },
        });
        if (freshSchedule.status !== OPERATION_STATUS.PLANNED) {
            throw ApiError.conflict(messages.OPERATION.SCHEDULE_NOT_PLANNED);
        }

        // Deduct inventory if a product is linked
        if (targetProductId) {
            const balances = await tx.inventoryBalance.findMany({
                where: {
                    productId: targetProductId,
                    quantity: { gt: 0 },
                },
                orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            });

            const totalAvailable = balances.reduce((sum, b) => sum + Number(b.quantity), 0);
            if (totalAvailable < actualQty) {
                throw ApiError.badRequest(messages.OPERATION.INSUFFICIENT_INVENTORY);
            }

            let remainingToDeduct = actualQty;
            const txGroupId = crypto.randomUUID();

            for (const balance of balances) {
                if (remainingToDeduct <= 0) break;
                const balQty = Number(balance.quantity);
                const deduct = Math.min(balQty, remainingToDeduct);
                const newBalQty = Number((balQty - deduct).toFixed(3));

                await tx.inventoryBalance.update({
                    where: { id: balance.id },
                    data: { quantity: newBalQty },
                });

                await tx.inventoryTransaction.create({
                    data: {
                        transactionGroupId: txGroupId,
                        productId: targetProductId,
                        inventoryBalanceId: balance.id,
                        seasonId: schedule.seasonId,
                        transactionType: 'STOCK_OUT',
                        quantity: deduct,
                        unitSnapshot: schedule.unit,
                        totalAmount: Number((deduct * Number(balance.unitPrice)).toFixed(2)),
                        referenceType: 'operation_execution',
                        referenceId: schedule.id,
                        reason: payload.note || 'Xuất kho vận hành ao nuôi',
                        performedBy: technicianId,
                        idempotencyKey: crypto.randomUUID(),
                    },
                });

                remainingToDeduct -= deduct;
            }
        }

        // Create execution
        const execution = await tx.operationExecution.create({
            data: {
                scheduleId: schedule.id,
                actualProductId: targetProductId,
                actualQuantity: actualQty,
                executedBy: technicianId,
                idempotencyKey: payload.idempotencyKey,
                executedAt: payload.executedAt ? new Date(payload.executedAt) : new Date(),
                note: payload.note || null,
                varianceReason: payload.varianceReason || null,
            },
            include: {
                actualProduct: {
                    select: { id: true, name: true, unit: true },
                },
            },
        });

        // Complete schedule
        await tx.operationSchedule.update({
            where: { id: schedule.id },
            data: { status: OPERATION_STATUS.COMPLETED },
        });

        return {
            ...execution,
            actualQuantity: toNumber(execution.actualQuantity),
        };
    });
};

/**
 * UC-12: Xem thống kê vận hành
 */
const getSeasonStats = async (technicianId, seasonId) => {
    // 1. Verify technician assignment
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

    const [total, planned, completed, cancelled, overdue] = await Promise.all([
        prisma.operationSchedule.count({ where: { seasonId } }),
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.PLANNED } }),
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.COMPLETED } }),
        prisma.operationSchedule.count({ where: { seasonId, status: OPERATION_STATUS.CANCELLED } }),
        prisma.operationSchedule.count({
            where: {
                seasonId,
                status: OPERATION_STATUS.PLANNED,
                scheduledAt: { lt: now },
            },
        }),
    ]);

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
    const completionRate = activeTotal > 0 ? Number(((completed / activeTotal) * 100).toFixed(2)) : 0;

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
    getSeasonStats,
};
