const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages, NOTIFICATION_TYPE, PROTOCOL_STATUS } = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

if (!BigInt.prototype.toJSON) {
    BigInt.prototype.toJSON = function () {
        return this.toString();
    };
}

const { createHash } = require('crypto');

const timeText = (value) => (value == null ? null : value.toISOString().slice(11, 23));

const viewId = (kind, itemId) => {
    const hash = createHash('sha256').update(`${kind}:${itemId}`).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

const wireItem = (entry) => ({
    id: entry.id,
    operationType: entry.operationType,
    productId: entry.productId,
    recommendedProductName: entry.recommendedProductName,
    recommendedCategory: entry.recommendedCategory,
    repeatIntervalDays: entry.repeatIntervalDays,
    doseBasis: entry.doseBasis,
    doseValue: String(entry.doseValue),
    doseUnit: entry.doseUnit,
    instructions: entry.instructions,
    product: entry.product && {
        id: entry.product.id,
        name: entry.product.name,
        category: entry.product.category,
        unit: entry.product.unit,
    },
});

const groupItems = (items) => {
    const stages = [];
    for (const entry of items) {
        let stage = stages.at(-1);
        const startDayOffset = entry.startDayOffset - 1;
        const endDayOffset = entry.endDayOffset - 1;
        if (!stage || stage.startDayOffset !== startDayOffset || stage.endDayOffset !== endDayOffset) {
            stage = {
                id: viewId('stage', entry.id),
                title: `DOC ${entry.startDayOffset}–${entry.endDayOffset}`,
                startDayOffset,
                endDayOffset,
                meals: [],
            };
            stages.push(stage);
        }
        let meal = stage.meals.at(-1);
        const planned = timeText(entry.plannedTime);
        if (!meal || meal.mealNumber !== entry.mealNumber || meal.plannedTime !== planned) {
            meal = {
                id: viewId('meal', entry.id),
                mealNumber: entry.mealNumber,
                plannedTime: planned,
                items: [],
            };
            stage.meals.push(meal);
        }
        meal.items.push(entry);
    }
    return stages;
};

const SEVERITY_ORDER = {
    CRITICAL: 1,
    HIGH: 2,
    MEDIUM: 3,
    LOW: 4,
};

/**
 * List disease cases assigned to the authenticated expert.
 */
const list = async (expertId, query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const where = {
        expertId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.seasonId ? { seasonId: query.seasonId } : {}),
        ...(query.farmId ? { season: { pond: { farmId: query.farmId } } } : {}),
        ...(query.search
            ? {
                OR: [
                    { title: { contains: query.search.trim(), mode: 'insensitive' } },
                    { description: { contains: query.search.trim(), mode: 'insensitive' } },
                    { season: { name: { contains: query.search.trim(), mode: 'insensitive' } } },
                    { season: { pond: { name: { contains: query.search.trim(), mode: 'insensitive' } } } },
                    { season: { pond: { farm: { name: { contains: query.search.trim(), mode: 'insensitive' } } } } },
                    { reporter: { fullName: { contains: query.search.trim(), mode: 'insensitive' } } },
                ],
            }
            : {}),
    };

    const [total, rawCases] = await Promise.all([
        prisma.diseaseCase.count({ where }),
        prisma.diseaseCase.findMany({
            where,
            include: {
                season: {
                    select: {
                        id: true,
                        name: true,
                        shrimpType: true,
                        pond: {
                            select: {
                                id: true,
                                name: true,
                                farm: {
                                    select: {
                                        id: true,
                                        name: true,
                                        address: true,
                                    },
                                },
                            },
                        },
                    },
                },
                reporter: {
                    select: {
                        id: true,
                        fullName: true,
                        role: true,
                    },
                },
                responses: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    select: {
                        id: true,
                        authorId: true,
                        createdAt: true,
                        author: {
                            select: { id: true, role: true },
                        },
                    },
                },
            },
            orderBy: [{ updatedAt: 'desc' }],
            skip,
            take: limit,
        }),
    ]);

    const items = rawCases.map((c) => {
        const lastResp = c.responses?.[0];
        const needsResponse =
            c.status !== 'RESOLVED' &&
            (!lastResp || lastResp.author?.role !== 'EXPERT');

        return {
            id: c.id,
            title: c.title,
            description: c.description,
            severity: c.severity,
            status: c.status,
            caseSnapshot: c.caseSnapshot,
            resolutionSummary: c.resolutionSummary,
            resolvedAt: c.resolvedAt,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            needsResponse,
            season: c.season,
            reporter: c.reporter,
        };
    });

    items.sort((a, b) => {
        const sevDiff = (SEVERITY_ORDER[a.severity] || 99) - (SEVERITY_ORDER[b.severity] || 99);
        if (sevDiff !== 0) return sevDiff;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    return {
        data: items,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
        },
        message: messages.DISEASE_CASE.LIST_FETCHED,
    };
};

/**
 * Get detailed disease case for clinical evaluation.
 */
const detail = async (expertId, caseId) => {
    const diseaseCase = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        include: {
            season: {
                include: {
                    pond: {
                        include: { farm: true },
                    },
                },
            },
            reporter: {
                select: {
                    id: true,
                    fullName: true,
                    phone: true,
                    email: true,
                    role: true,
                },
            },
            expert: {
                select: {
                    id: true,
                    fullName: true,
                    phone: true,
                    email: true,
                    role: true,
                },
            },
            resolver: {
                select: {
                    id: true,
                    fullName: true,
                    role: true,
                },
            },
            attachments: {
                orderBy: { createdAt: 'asc' },
            },
            responses: {
                include: {
                    author: {
                        select: {
                            id: true,
                            fullName: true,
                            role: true,
                        },
                    },
                },
                orderBy: { createdAt: 'asc' },
            },
            statusHistory: {
                include: {
                    changer: {
                        select: {
                            id: true,
                            fullName: true,
                            role: true,
                        },
                    },
                },
                orderBy: { changedAt: 'desc' },
            },
            protocols: {
                include: {
                    items: {
                        include: {
                            product: {
                                select: {
                                    id: true,
                                    name: true,
                                    unit: true,
                                    category: true,
                                },
                            },
                        },
                        orderBy: [{ startDayOffset: 'asc' }, { sequenceOrder: 'asc' }],
                    },
                },
                orderBy: { versionNo: 'desc' },
            },
        },
    });

    if (!diseaseCase) {
        throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    }

    if (diseaseCase.expertId !== expertId) {
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    }

    // Schedule metrics for treatment protocols
    const protocolsWithMetrics = await Promise.all(
        diseaseCase.protocols.map(async (p) => {
            const itemIds = p.items.map((i) => i.id);
            const [completedCount, plannedCount, cancelledCount] = await Promise.all([
                prisma.operationSchedule.count({
                    where: { protocolItemId: { in: itemIds }, status: 'COMPLETED' },
                }),
                prisma.operationSchedule.count({
                    where: { protocolItemId: { in: itemIds }, status: 'PLANNED' },
                }),
                prisma.operationSchedule.count({
                    where: { protocolItemId: { in: itemIds }, status: 'CANCELLED' },
                }),
            ]);

            const stages = groupItems(p.items).map((stage) => ({
                ...stage,
                meals: stage.meals.map((meal) => ({
                    ...meal,
                    items: meal.items.map(wireItem),
                })),
            }));

            const statusHistoryRows = await prisma.protocolStatusHistory.findMany({
                where: { protocolId: p.id },
                orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
            });

            return {
                ...p,
                allowedVariancePct: p.allowedVariancePct != null ? String(p.allowedVariancePct) : '10',
                rollingWindowDays: p.rollingWindowDays || 3,
                availableActions: {
                    update: false,
                    submit: false,
                },
                stages,
                statusHistory: statusHistoryRows,
                metrics: {
                    completedCount,
                    plannedCount,
                    cancelledCount,
                    totalSchedules: completedCount + plannedCount + cancelledCount,
                },
            };
        }),
    );

    // Latest health and water logs
    const [latestHealthLog, latestWaterLog] = await Promise.all([
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId: diseaseCase.seasonId, isVoided: false },
            orderBy: { recordedAt: 'desc' },
            select: {
                id: true,
                recordedAt: true,
                avgWeightG: true,
                avgLengthCm: true,
                estimatedBiomassKg: true,
                healthStatus: true,
                note: true,
            },
        }),
        prisma.waterQualityLog.findFirst({
            where: { seasonId: diseaseCase.seasonId, isVoided: false },
            orderBy: { recordedAt: 'desc' },
            select: {
                id: true,
                recordedAt: true,
                temperatureC: true,
                ph: true,
                dissolvedOxygenMgL: true,
                salinityPpt: true,
                alkalinityMgLCaCO3: true,
                nh3MgL: true,
                no2MgL: true,
            },
        }),
    ]);

    return {
        ...diseaseCase,
        protocols: protocolsWithMetrics,
        latestHealthLog,
        latestWaterLog,
    };
};

/**
 * Expert responds to the disease case (BR-CASE-02).
 */
const respond = async (expertId, caseId, data) => {
    const diseaseCase = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        include: {
            season: {
                include: {
                    pond: { include: { farm: true } },
                },
            },
        },
    });

    if (!diseaseCase) {
        throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    }

    if (diseaseCase.expertId !== expertId) {
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    }

    if (diseaseCase.status === 'RESOLVED') {
        throw ApiError.badRequest(messages.DISEASE_CASE.ALREADY_RESOLVED);
    }

    const isRequestInfo = data.responseType === 'REQUEST_INFO';
    const isMonitoring = data.switchToMonitoring === true;
    let nextStatus = null;
    let statusReason = null;

    if (isRequestInfo && diseaseCase.status !== 'WAITING_FOR_INFO') {
        nextStatus = 'WAITING_FOR_INFO';
        statusReason = 'Chuyên gia yêu cầu thêm thông tin/kết quả xét nghiệm';
    } else if (isMonitoring && diseaseCase.status !== 'MONITORING') {
        nextStatus = 'MONITORING';
        statusReason = 'Chuyên gia chỉ dẫn xử lý và chuyển ca sang trạng thái theo dõi';
    }

    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
        if (nextStatus) {
            await tx.diseaseCase.update({
                where: { id: caseId },
                data: {
                    status: nextStatus,
                    updatedAt: now,
                },
            });

            await tx.diseaseCaseStatusHistory.create({
                data: {
                    caseId,
                    fromStatus: diseaseCase.status,
                    toStatus: nextStatus,
                    changedBy: expertId,
                    reason: statusReason,
                    changedAt: now,
                },
            });
        } else {
            await tx.diseaseCase.update({
                where: { id: caseId },
                data: { updatedAt: now },
            });
        }

        const newResponse = await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: data.responseType,
                message: data.message,
                attachments: data.attachments || [],
                createdAt: now,
            },
            include: {
                author: {
                    select: { id: true, fullName: true, role: true },
                },
            },
        });

        // Create notifications for KTV reporter and Owner
        const ownerId = diseaseCase.season?.pond?.farm?.ownerId;
        const recipients = [diseaseCase.reportedBy, ownerId].filter(Boolean);

        const typeLabelMap = {
            REQUEST_INFO: 'Yêu cầu bổ sung thông tin ca bệnh',
            EXPERT_ASSESSMENT: 'Nhận định chuyên môn ca bệnh',
            EXPERT_INSTRUCTION: 'Chỉ dẫn xử lý ca bệnh',
        };

        const notifTitle = typeLabelMap[data.responseType] || 'Phản hồi mới từ Chuyên gia';
        const notifContent = `Chuyên gia đã phản hồi về ca bệnh "${diseaseCase.title}": ${data.message.slice(0, 100)}`;

        for (const recipientId of recipients) {
            if (recipientId !== expertId) {
                const notif = await tx.notification.create({
                    data: {
                        accountId: recipientId,
                        title: notifTitle,
                        content: notifContent,
                        type: isRequestInfo
                            ? NOTIFICATION_TYPE.DISEASE_CASE_WAITING_INFO
                            : isMonitoring
                                ? NOTIFICATION_TYPE.DISEASE_CASE_MONITORING
                                : NOTIFICATION_TYPE.DISEASE_CASE_RESPONSE,
                        referenceType: 'disease_case',
                        referenceId: caseId,
                    },
                });
                emitNotification(recipientId, 'notification:new', notif);
            }
        }

        return newResponse;
    });

    return result;
};

/**
 * Mark a disease case as RESOLVED (BR-CASE-03).
 */
const resolve = async (expertId, caseId, data) => {
    const diseaseCase = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        include: {
            season: {
                include: {
                    pond: { include: { farm: true } },
                },
            },
        },
    });

    if (!diseaseCase) {
        throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    }

    if (diseaseCase.expertId !== expertId) {
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    }

    if (diseaseCase.status === 'RESOLVED') {
        throw ApiError.badRequest(messages.DISEASE_CASE.ALREADY_RESOLVED);
    }

    if (!data.resolutionSummary || !data.resolutionSummary.trim()) {
        throw ApiError.badRequest(messages.DISEASE_CASE.RESOLUTION_SUMMARY_REQUIRED);
    }

    const now = new Date();
    const summary = data.resolutionSummary.trim();

    const result = await prisma.$transaction(async (tx) => {
        const updatedCase = await tx.diseaseCase.update({
            where: { id: caseId },
            data: {
                status: 'RESOLVED',
                resolutionSummary: summary,
                resolvedBy: expertId,
                resolvedAt: now,
                updatedAt: now,
            },
        });

        await tx.diseaseCaseStatusHistory.create({
            data: {
                caseId,
                fromStatus: diseaseCase.status,
                toStatus: 'RESOLVED',
                changedBy: expertId,
                reason: summary,
                changedAt: now,
            },
        });

        await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'RESOLUTION',
                message: `[KẾT THÚC CA BỆNH]: ${summary}`,
                attachments: [],
                createdAt: now,
            },
        });

        const ownerId = diseaseCase.season?.pond?.farm?.ownerId;
        const recipients = [diseaseCase.reportedBy, ownerId].filter(Boolean);

        for (const recipientId of recipients) {
            if (recipientId !== expertId) {
                const notif = await tx.notification.create({
                    data: {
                        accountId: recipientId,
                        title: 'Ca bệnh đã được đánh dấu giải quyết',
                        content: `Chuyên gia đã kết luận ca bệnh "${diseaseCase.title}": ${summary.slice(0, 100)}`,
                        type: NOTIFICATION_TYPE.DISEASE_CASE_RESOLVED,
                        referenceType: 'disease_case',
                        referenceId: caseId,
                    },
                });
                emitNotification(recipientId, 'notification:new', notif);
            }
        }

        return updatedCase;
    });

    return result;
};

/**
 * Emergency Treatment Abort (BR-TRT-01, BR-TRT-02, BR-TRT-03).
 */
const abortProtocol = async (expertId, caseId, protocolId, data) => {
    const diseaseCase = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        include: {
            season: {
                include: {
                    pond: { include: { farm: true } },
                },
            },
        },
    });

    if (!diseaseCase) {
        throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    }

    if (diseaseCase.expertId !== expertId) {
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    }

    const protocol = await prisma.protocol.findUnique({
        where: { id: protocolId },
        include: { items: true },
    });

    if (!protocol || protocol.diseaseCaseId !== caseId) {
        throw ApiError.notFound('Không tìm thấy phác đồ điều trị liên kết với ca bệnh này');
    }

    if (protocol.status !== PROTOCOL_STATUS.APPROVED) {
        throw ApiError.badRequest('Chỉ có thể dừng khẩn cấp phác đồ điều trị đang áp dụng (APPROVED)');
    }

    const now = new Date();
    const reason = data.reason.trim();
    const itemIds = protocol.items.map((i) => i.id);

    const result = await prisma.$transaction(async (tx) => {
        // 1. Update protocol to ABORTED
        await tx.protocol.update({
            where: { id: protocolId },
            data: {
                status: PROTOCOL_STATUS.ABORTED,
                abortReason: reason,
                abortedBy: expertId,
                abortedAt: now,
                updatedAt: now,
            },
        });

        // 2. Append protocol status history
        await tx.protocolStatusHistory.create({
            data: {
                protocolId,
                fromStatus: PROTOCOL_STATUS.APPROVED,
                toStatus: PROTOCOL_STATUS.ABORTED,
                changedBy: expertId,
                reason,
                changedAt: now,
            },
        });

        // 3. Cancel only unexecuted future PLANNED schedules
        const cancelResult = await tx.operationSchedule.updateMany({
            where: {
                protocolItemId: { in: itemIds },
                status: 'PLANNED',
            },
            data: {
                status: 'CANCELLED',
                cancellationReason: `Dừng khẩn cấp phác đồ: ${reason}`,
                cancelledBy: expertId,
                cancelledAt: now,
                updatedAt: now,
            },
        });

        // 4. Move Disease Case to MONITORING
        if (diseaseCase.status !== 'MONITORING' && diseaseCase.status !== 'RESOLVED') {
            await tx.diseaseCase.update({
                where: { id: caseId },
                data: {
                    status: 'MONITORING',
                    updatedAt: now,
                },
            });

            await tx.diseaseCaseStatusHistory.create({
                data: {
                    caseId,
                    fromStatus: diseaseCase.status,
                    toStatus: 'MONITORING',
                    changedBy: expertId,
                    reason: `Phác đồ điều trị v${protocol.versionNo} bị dừng khẩn cấp: ${reason}`,
                    changedAt: now,
                },
            });
        }

        // 5. Append emergency alert response
        await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'EMERGENCY_ALERT',
                message: `[DỪNG KHẨN CẤP PHÁC ĐỒ v${protocol.versionNo}]: ${reason}. Đã hủy ${cancelResult.count} lịch điều trị chưa thực hiện. Ca chuyển sang chế độ theo dõi.`,
                attachments: [],
                createdAt: now,
            },
        });

        // 6. Notify KTV and Owner
        const ownerId = diseaseCase.season?.pond?.farm?.ownerId;
        const recipients = [diseaseCase.reportedBy, ownerId].filter(Boolean);

        for (const recipientId of recipients) {
            if (recipientId !== expertId) {
                const notif = await tx.notification.create({
                    data: {
                        accountId: recipientId,
                        title: `Dừng khẩn cấp phác đồ điều trị: ${protocol.title}`,
                        content: `Chuyên gia đã dừng khẩn cấp phác đồ cho ca bệnh "${diseaseCase.title}". Lý do: ${reason}`,
                        type: NOTIFICATION_TYPE.TREATMENT_PROTOCOL_ABORTED,
                        referenceType: 'disease_case',
                        referenceId: caseId,
                    },
                });
                emitNotification(recipientId, 'notification:new', notif);
            }
        }

        return {
            protocolId,
            abortedAt: now,
            cancelledSchedulesCount: cancelResult.count,
        };
    });

    return result;
};

module.exports = {
    list,
    detail,
    respond,
    resolve,
    abortProtocol,
};
