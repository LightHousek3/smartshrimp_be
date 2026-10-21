const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { stockQuantity, vietnamDate } = require('../utils/inventoryQuantity');
const prisma = require('../config/prisma');
const { emitNotification } = require('../realtime/notification.socket');
const { ApiError } = require('../utils');
const withdrawal = require('./harvestWithdrawal.service');
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
                    doseBasis: true,
                    doseValue: true,
                    doseUnit: true,
                    instructions: true,
                    sequenceOrder: true,
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

    return formatSchedule(schedule);
};

/**
 * UC-11: Ghi nhận thực hiện hoạt động
 */
const executeSchedule = async (technicianId, scheduleId, payload) => {
    const pointer = await prisma.operationSchedule.findUnique({ where: { id: scheduleId }, select: { seasonId: true } });
    if (!pointer) throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
    const actual = new Prisma.Decimal(payload.actualQuantity);
    if (!actual.isFinite() || actual.lte(0) || actual.decimalPlaces() > 9) {
        throw ApiError.badRequest('Số lượng thực tế phải dương và tối đa 9 số thập phân');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.$transaction(async (tx) => {
                // Shared order with harvest: season -> schedule -> actual product -> receipt layers.
                await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${pointer.seasonId}::uuid FOR UPDATE`;
                await tx.$queryRaw`SELECT id FROM operation_schedules WHERE id = ${scheduleId}::uuid FOR UPDATE`;
                const schedule = await tx.operationSchedule.findUnique({
                    where: { id: scheduleId },
                    include: {
                        season: { include: { pond: { select: { farmId: true } } } },
                        protocolItem: { select: { protocol: { select: { allowedVariancePct: true, protocolType: true, diseaseCaseId: true } } } },
                    },
                });
                if (!schedule) throw ApiError.notFound(messages.OPERATION.NOT_FOUND);
                const assignment = await tx.seasonPersonnelAssignment.findFirst({
                    where: { seasonId: schedule.seasonId, accountId: technicianId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null },
                    select: { id: true },
                });
                if (!assignment) throw ApiError.forbidden(messages.OPERATION.NOT_ASSIGNED_TECHNICIAN);
                const targetProductId = payload.actualProductId || schedule.productId;
                if (!targetProductId) throw ApiError.badRequest(messages.HARVEST.WITHDRAWAL_PRODUCT_NOT_READY);
                const existing = await tx.operationExecution.findUnique({
                    where: { idempotencyKey: payload.idempotencyKey },
                    include: { actualProduct: { select: { id: true, name: true, unit: true } } },
                });
                if (existing) {
                    if (existing.scheduleId !== scheduleId || existing.executedBy !== technicianId
                        || existing.actualProductId !== targetProductId || !actual.equals(existing.actualQuantity)
                        || (payload.executedAt && existing.executedAt.getTime() !== new Date(payload.executedAt).getTime())
                        || (existing.note || null) !== (payload.note || null)
                        || (existing.varianceReason || null) !== (payload.varianceReason || null)) {
                        throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
                    }
                    return { ...existing, actualQuantity: Number(existing.actualQuantity) };
                }
                if (schedule.season.status !== SEASON_STATUS.ACTIVE) throw ApiError.badRequest(messages.OPERATION.SEASON_NOT_ACTIVE);
                if (schedule.status !== OPERATION_STATUS.PLANNED) throw ApiError.conflict(messages.OPERATION.SCHEDULE_NOT_PLANNED);
                const protocol = schedule.protocolItem.protocol;
                const planned = new Prisma.Decimal(schedule.plannedQuantity);
                const variance = actual.minus(planned).abs().div(planned).mul(100);
                if (variance.gt(protocol.allowedVariancePct ?? 10) && !payload.varianceReason?.trim()) {
                    throw ApiError.badRequest(messages.OPERATION.VARIANCE_REASON_REQUIRED);
                }
                const executedAt = payload.executedAt ? new Date(payload.executedAt) : new Date();
                const days = await withdrawal.prepareExecution(tx, schedule.seasonId, targetProductId, schedule.operationType, executedAt, protocol);
                const executionId = crypto.randomUUID();
                if (targetProductId) {
                    const product = await tx.product.findFirst({
                        where: { id: targetProductId, farmId: schedule.season.pond.farmId },
                    });
                    if (!product) throw ApiError.badRequest(messages.HARVEST.WITHDRAWAL_PRODUCT_NOT_READY);
                    const requested = stockQuantity(actual, schedule.unit, product);
                    const balances = await tx.inventoryBalance.findMany({
                        where: { productId: targetProductId, quantity: { gt: 0 }, expiryDate: { gte: vietnamDate(executedAt) } },
                        orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
                    });
                    const available = balances.reduce((total, balance) => total.add(balance.quantity), new Prisma.Decimal(0));
                    if (available.lt(requested)) throw ApiError.badRequest(messages.OPERATION.INSUFFICIENT_INVENTORY);
                    let remaining = requested;
                    const groupId = crypto.randomUUID();
                    for (const balance of balances) {
                        if (remaining.lte(0)) break;
                        const deduction = Prisma.Decimal.min(remaining, balance.quantity);
                        const changed = await tx.inventoryBalance.updateMany({
                            where: { id: balance.id, productId: targetProductId, quantity: { gte: deduction } },
                            data: { quantity: { decrement: deduction } },
                        });
                        if (changed.count !== 1) throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
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
                }
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
                    include: { actualProduct: { select: { id: true, name: true, unit: true } } },
                });
                const completed = await tx.operationSchedule.updateMany({ where: { id: scheduleId, status: 'PLANNED' }, data: { status: 'COMPLETED' } });
                if (completed.count !== 1) throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
                return { ...execution, actualQuantity: Number(execution.actualQuantity) };
            }, { isolationLevel: 'Serializable' });
        } catch (error) {
            const retryable = error.code === 'P2034'
                || (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
            if (retryable && attempt < 2) continue;
            if (retryable || error.code === 'P2002') throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
            if (error instanceof ApiError && error.message === messages.OPERATION.INSUFFICIENT_INVENTORY) {
                const notice = await prisma.notification.create({ data: {
                    accountId: technicianId,
                    title: 'Tồn kho hợp lệ không đủ để thực hiện vận hành',
                    content: 'Kiểm tra số lượng, hạn sử dụng và hồ sơ của vật tư trước khi thực hiện lại.',
                    type: NOTIFICATION_TYPE.INVENTORY_INSUFFICIENT,
                    referenceType: 'operation_schedule',
                    referenceId: scheduleId,
                } });
                emitNotification(technicianId, 'notification:new', { id: notice.id, referenceId: scheduleId });
            }
            throw error;
        }
    }
    throw ApiError.conflict(messages.OPERATION.EXECUTION_CONFLICT);
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
