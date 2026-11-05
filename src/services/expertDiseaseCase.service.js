const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    messages,
    NOTIFICATION_TYPE,
    PROTOCOL_STATUS,
    SCHEDULE_CANCELLATION_TYPE,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');
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

/**
 * List disease cases assigned to the authenticated expert.
 */
const list = async (expertId, query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 10));
    const skip = (page - 1) * limit;

    const where = {
        expertId,
        ...(query.status && query.status !== 'action' ? { status: query.status } : {}),
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

    // F07: Handle multiple severities or array
    if (query.severity) {
        const sevs = Array.isArray(query.severity)
            ? query.severity
            : query.severity.includes(',')
                ? query.severity.split(',').map((s) => s.trim()).filter(Boolean)
                : [query.severity];
        where.severity = sevs.length === 1 ? sevs[0] : { in: sevs };
    }

    // F07: Filter "Needs response" directly before pagination
    if (query.needsResponse === true || query.needsResponse === 'true' || query.status === 'action') {
        const matchingCases = await prisma.$queryRaw`
            SELECT c.id FROM disease_cases c
            WHERE c.expert_id = ${expertId}::uuid
              AND c.status <> 'RESOLVED'
              AND (
                NOT EXISTS (SELECT 1 FROM disease_case_responses r WHERE r.case_id = c.id)
                OR (
                  SELECT a.role FROM disease_case_responses r
                  JOIN accounts a ON a.id = r.author_id
                  WHERE r.case_id = c.id
                  ORDER BY r.created_at DESC LIMIT 1
                ) <> 'expert'::account_role
              )
        `;
        const ids = matchingCases.map((r) => r.id);
        where.id = { in: ids };
    }

    // F08: Sort entire table by severity priority and updatedAt before pagination
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
            orderBy: [
                { severity: 'desc' },
                { updatedAt: 'desc' },
                { id: 'desc' },
            ],
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
 * Get disease case details by ID.
 */
const detail = async (expertId, caseId) => {
    const diseaseCase = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        include: {
            reporter: {
                select: { id: true, fullName: true, phone: true, role: true, avatarUrl: true },
            },
            expert: {
                select: { id: true, fullName: true, phone: true, role: true, avatarUrl: true },
            },
            season: {
                select: {
                    id: true,
                    name: true,
                    status: true,
                    shrimpType: true,
                    stockingDate: true,
                    initialQuantity: true,
                    pond: {
                        select: {
                            id: true,
                            name: true,
                            areaM2: true,
                            volumeM3: true,
                            farm: {
                                select: {
                                    id: true,
                                    name: true,
                                    ownerId: true,
                                    address: true,
                                    owner: {
                                        select: { id: true, fullName: true, phone: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            attachments: {
                orderBy: { createdAt: 'desc' },
            },
            responses: {
                orderBy: { createdAt: 'asc' },
                include: {
                    author: {
                        select: { id: true, fullName: true, role: true, avatarUrl: true },
                    },
                },
            },
            statusHistory: {
                orderBy: { changedAt: 'desc' },
                include: {
                    changer: {
                        select: { id: true, fullName: true, role: true },
                    },
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

    // Fetch active/linked protocols for this disease case
    const linkedProtocols = await prisma.protocol.findMany({
        where: {
            diseaseCaseId: caseId,
        },
        orderBy: { versionNo: 'desc' },
        include: {
            items: {
                orderBy: [
                    { startDayOffset: 'asc' },
                    { mealNumber: 'asc' },
                    { plannedTime: 'asc' },
                ],
                include: {
                    product: {
                        select: { id: true, name: true, category: true, unit: true },
                    },
                },
            },
            statusHistory: {
                orderBy: { changedAt: 'desc' },
                select: {
                    id: true,
                    fromStatus: true,
                    toStatus: true,
                    changedBy: true,
                    changedAt: true,
                    reason: true,
                },
            },
        },
    });

    // Populate changer accounts for protocol status histories
    const protoChangerIds = new Set();
    linkedProtocols.forEach((p) => {
        (p.statusHistory || []).forEach((h) => {
            if (h.changedBy) protoChangerIds.add(h.changedBy);
        });
    });

    const protoChangers = protoChangerIds.size > 0
        ? await prisma.account.findMany({
            where: { id: { in: Array.from(protoChangerIds) } },
            select: { id: true, fullName: true, role: true },
        })
        : [];
    const protoChangerMap = new Map(protoChangers.map((c) => [c.id, c]));

    // Compute progress metrics for each protocol
    const protocolsWithMetrics = await Promise.all(
        linkedProtocols.map(async (proto) => {
            const itemIds = proto.items.map((i) => i.id);
            let totalSchedules = 0;
            let completedCount = 0;
            let cancelledCount = 0;

            if (itemIds.length > 0) {
                const [tot, comp, canc] = await Promise.all([
                    prisma.operationSchedule.count({
                        where: { protocolItemId: { in: itemIds } },
                    }),
                    prisma.operationSchedule.count({
                        where: {
                            protocolItemId: { in: itemIds },
                            status: 'COMPLETED',
                        },
                    }),
                    prisma.operationSchedule.count({
                        where: {
                            protocolItemId: { in: itemIds },
                            status: 'CANCELLED',
                        },
                    }),
                ]);
                totalSchedules = tot;
                completedCount = comp;
                cancelledCount = canc;
            }

            const rawItems = proto.items.map(wireItem);
            const stages = groupItems(rawItems);

            const statusHistoryWithChanger = (proto.statusHistory || []).map((h) => ({
                ...h,
                changer: protoChangerMap.get(h.changedBy) || null,
            }));

            return {
                id: proto.id,
                protocolCode: `PRT-CASE-${proto.versionNo}`,
                protocolType: proto.protocolType,
                title: proto.title,
                summary: proto.summary,
                versionNo: proto.versionNo,
                status: proto.status,
                allowedVariancePct: proto.allowedVariancePct,
                rollingWindowDays: proto.rollingWindowDays,
                abortReason: proto.abortReason,
                abortedAt: proto.abortedAt,
                createdAt: proto.createdAt,
                updatedAt: proto.updatedAt,
                stages,
                statusHistory: statusHistoryWithChanger,
                metrics: {
                    totalSchedules,
                    completedCount,
                    cancelledCount,
                    progressPct: totalSchedules > 0
                        ? Math.round((completedCount / totalSchedules) * 100)
                        : 0,
                },
            };
        })
    );

    // Latest shrimp health log & water quality log for comparative snapshot
    const [latestHealth, latestWater] = await Promise.all([
        prisma.shrimpHealthLog.findFirst({
            where: { seasonId: diseaseCase.seasonId, isVoided: false },
            orderBy: { recordedAt: 'desc' },
        }),
        prisma.waterQualityLog.findFirst({
            where: { seasonId: diseaseCase.seasonId, isVoided: false },
            orderBy: { recordedAt: 'desc' },
        }),
    ]);

    return {
        ...diseaseCase,
        protocols: protocolsWithMetrics,
        latestWaterLog: latestWater,
        latestMetrics: {
            health: latestHealth
                ? {
                    ...latestHealth,
                    mortalityCount:
                        latestHealth.mortalityCount != null
                            ? Number(latestHealth.mortalityCount)
                            : 0,
                    estimatedPopulation:
                        latestHealth.estimatedPopulation != null
                            ? Number(latestHealth.estimatedPopulation)
                            : null,
                    avgWeightG:
                        latestHealth.avgWeightG != null
                            ? Number(latestHealth.avgWeightG)
                            : null,
                    avgLengthCm:
                        latestHealth.avgLengthCm != null
                            ? Number(latestHealth.avgLengthCm)
                            : null,
                    estimatedBiomassKg:
                        latestHealth.estimatedBiomassKg != null
                            ? Number(latestHealth.estimatedBiomassKg)
                            : null,
                }
                : null,
            water: latestWater,
        },
    };
};

/**
 * Expert responds to the disease case (BR-CASE-02).
 */
const respond = async (expertId, caseId, data) => {
    const now = new Date();
    const pendingNotifications = [];

    const result = await prisma.$transaction(async (tx) => {
        // F05: Read and validate inside transaction
        const diseaseCase = await tx.diseaseCase.findUnique({
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

        // F09: State machine alignment
        const isRequestInfo = data.responseType === 'REQUEST_INFO';
        const isInstruction = data.responseType === 'EXPERT_INSTRUCTION';
        const isMonitoring = isInstruction && data.switchToMonitoring === true;
        let nextStatus = null;
        let statusReason = null;

        // Never downgrade IN_TREATMENT status via basic info request or instruction switch
        if (diseaseCase.status !== 'IN_TREATMENT') {
            if (isRequestInfo && diseaseCase.status !== 'WAITING_FOR_INFO') {
                nextStatus = 'WAITING_FOR_INFO';
                statusReason = 'Chuyên gia yêu cầu thêm thông tin/kết quả xét nghiệm';
            } else if (isMonitoring && diseaseCase.status !== 'MONITORING') {
                nextStatus = 'MONITORING';
                statusReason = 'Chuyên gia chỉ dẫn xử lý và chuyển ca sang trạng thái theo dõi';
            }
        }

        // F05: Atomic conditional update
        if (nextStatus) {
            const updateCount = await tx.diseaseCase.updateMany({
                where: { id: caseId, expertId, status: diseaseCase.status },
                data: {
                    status: nextStatus,
                    updatedAt: now,
                },
            });
            if (updateCount.count === 0) {
                throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
            }

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
            const updateCount = await tx.diseaseCase.updateMany({
                where: { id: caseId, expertId, status: diseaseCase.status },
                data: { updatedAt: now },
            });
            if (updateCount.count === 0) {
                throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
            }
        }

        const newResponse = await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: data.responseType,
                message: data.message.trim(),
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
                // F10: Collect notification to emit AFTER commit
                pendingNotifications.push({ recipientId, event: 'notification:new', payload: notif });
            }
        }

        return newResponse;
    });

    // F10: Emit notifications after transaction is successfully committed
    for (const item of pendingNotifications) {
        try {
            emitNotification(item.recipientId, item.event, item.payload);
        } catch {
            // Ignore socket delivery error
        }
    }

    return result;
};

/**
 * Mark a disease case as RESOLVED (BR-CASE-03).
 */
const resolve = async (expertId, caseId, data) => {
    if (!data.resolutionSummary || !data.resolutionSummary.trim()) {
        throw ApiError.badRequest(messages.DISEASE_CASE.RESOLUTION_SUMMARY_REQUIRED);
    }

    const now = new Date();
    const summary = data.resolutionSummary.trim();
    const pendingNotifications = [];

    const result = await prisma.$transaction(async (tx) => {
        // F05: Read and validate inside transaction
        const diseaseCase = await tx.diseaseCase.findUnique({
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

        // F04: Check active linked protocols before resolving
        const activeProtocols = await tx.protocol.findMany({
            where: {
                diseaseCaseId: caseId,
                status: { in: [PROTOCOL_STATUS.PENDING_APPROVAL, PROTOCOL_STATUS.APPROVED] },
            },
            include: {
                items: { select: { id: true } },
            },
        });

        const pendingProto = activeProtocols.find((p) => p.status === PROTOCOL_STATUS.PENDING_APPROVAL);
        if (pendingProto) {
            throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_PENDING_APPROVAL_BLOCK);
        }

        const approvedProto = activeProtocols.find((p) => p.status === PROTOCOL_STATUS.APPROVED);
        if (approvedProto) {
            const itemIds = approvedProto.items.map((i) => i.id);
            const remainingPlanned = await tx.operationSchedule.count({
                where: {
                    protocolItemId: { in: itemIds },
                    status: 'PLANNED',
                },
            });
            if (remainingPlanned > 0) {
                throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
            }
        }

        // F05: Atomic conditional update
        const updateCount = await tx.diseaseCase.updateMany({
            where: { id: caseId, expertId, status: { not: 'RESOLVED' } },
            data: {
                status: 'RESOLVED',
                resolutionSummary: summary,
                resolvedBy: expertId,
                resolvedAt: now,
                updatedAt: now,
            },
        });

        if (updateCount.count === 0) {
            throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
        }

        await tx.diseaseCaseStatusHistory.create({
            data: {
                caseId,
                fromStatus: diseaseCase.status,
                toStatus: 'RESOLVED',
                changedBy: expertId,
                reason: summary.slice(0, 500),
                changedAt: now,
            },
        });

        // F06: Store raw summary directly (responseType=RESOLUTION identifies type, avoiding >500 overflow)
        await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'RESOLUTION',
                message: summary.slice(0, 500),
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
                // F10: Collect notification to emit AFTER commit
                pendingNotifications.push({ recipientId, event: 'notification:new', payload: notif });
            }
        }

        return tx.diseaseCase.findUnique({ where: { id: caseId } });
    });

    // F10: Emit notifications after commit
    for (const item of pendingNotifications) {
        try {
            emitNotification(item.recipientId, item.event, item.payload);
        } catch {
            // Ignore socket delivery error
        }
    }

    return result;
};

/**
 * Emergency Treatment Abort (BR-TRT-01, BR-TRT-02, BR-TRT-03).
 */
const abortProtocol = async (expertId, caseId, protocolId, data) => {
    const now = new Date();
    const reason = data.reason.trim();
    const pendingNotifications = [];

    const result = await prisma.$transaction(async (tx) => {
        // F05: Read and validate inside transaction
        const diseaseCase = await tx.diseaseCase.findUnique({
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

        const protocol = await tx.protocol.findUnique({
            where: { id: protocolId },
            include: { items: true },
        });

        if (!protocol || protocol.diseaseCaseId !== caseId) {
            throw ApiError.notFound(messages.DISEASE_CASE.PROTOCOL_NOT_FOUND);
        }

        if (protocol.status !== PROTOCOL_STATUS.APPROVED) {
            throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_NOT_APPROVED);
        }

        const itemIds = protocol.items.map((i) => i.id);

        // F05: Atomic update protocol to ABORTED
        const updateProtocolCount = await tx.protocol.updateMany({
            where: { id: protocolId, diseaseCaseId: caseId, status: PROTOCOL_STATUS.APPROVED },
            data: {
                status: PROTOCOL_STATUS.ABORTED,
                abortReason: reason.slice(0, 500),
                abortedBy: expertId,
                abortedAt: now,
                updatedAt: now,
            },
        });

        if (updateProtocolCount.count === 0) {
            throw ApiError.conflict(messages.DISEASE_CASE.PROTOCOL_STATUS_CONFLICT);
        }

        // Append protocol status history
        await tx.protocolStatusHistory.create({
            data: {
                protocolId,
                fromStatus: PROTOCOL_STATUS.APPROVED,
                toStatus: PROTOCOL_STATUS.ABORTED,
                changedBy: expertId,
                reason: reason.slice(0, 500),
                changedAt: now,
            },
        });

        // F01 & F06: Cancel future PLANNED schedules with cancellationType and <=500 chars reason
        const cancelResult = await tx.operationSchedule.updateMany({
            where: {
                protocolItemId: { in: itemIds },
                status: 'PLANNED',
            },
            data: {
                status: 'CANCELLED',
                cancellationType: SCHEDULE_CANCELLATION_TYPE.TREATMENT_ABORTED,
                cancellationReason: reason.slice(0, 500),
                cancelledBy: expertId,
                cancelledAt: now,
                updatedAt: now,
            },
        });

        // Move Disease Case to MONITORING if not already resolved
        if (diseaseCase.status !== 'MONITORING' && diseaseCase.status !== 'RESOLVED') {
            await tx.diseaseCase.updateMany({
                where: { id: caseId, status: { notIn: ['MONITORING', 'RESOLVED'] } },
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
                    reason: reason.slice(0, 500),
                    changedAt: now,
                },
            });
        }

        // F06: Append emergency alert response with message <= 500 chars
        await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'EMERGENCY_ALERT',
                message: reason.slice(0, 500),
                attachments: [],
                createdAt: now,
            },
        });

        // Notify KTV and Owner
        const ownerId = diseaseCase.season?.pond?.farm?.ownerId;
        const recipients = [diseaseCase.reportedBy, ownerId].filter(Boolean);

        for (const recipientId of recipients) {
            if (recipientId !== expertId) {
                const notif = await tx.notification.create({
                    data: {
                        accountId: recipientId,
                        title: `Dừng khẩn cấp phác đồ điều trị: ${protocol.title}`.slice(0, 255),
                        content: `Chuyên gia đã dừng khẩn cấp phác đồ cho ca bệnh "${diseaseCase.title}". Lý do: ${reason.slice(0, 200)}`,
                        type: NOTIFICATION_TYPE.TREATMENT_PROTOCOL_ABORTED,
                        referenceType: 'disease_case',
                        referenceId: caseId,
                    },
                });
                // F10: Collect notification to emit AFTER commit
                pendingNotifications.push({ recipientId, event: 'notification:new', payload: notif });
            }
        }

        return {
            protocolId,
            abortedAt: now,
            cancelledSchedulesCount: cancelResult.count,
        };
    });

    // F10: Emit notifications after commit
    for (const item of pendingNotifications) {
        try {
            emitNotification(item.recipientId, item.event, item.payload);
        } catch {
            // Ignore socket delivery error
        }
    }

    return result;
};

module.exports = {
    list,
    detail,
    respond,
    resolve,
    abortProtocol,
};
