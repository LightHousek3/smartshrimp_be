const SEVERITY_WEIGHT = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
};

const prisma = require('../config/prisma');
const lifecycle = require('./protocolLifecycle.service');
const { ApiError } = require('../utils');
const {
    messages,
    NOTIFICATION_TYPE,
    PROTOCOL_STATUS,
    WATER_THRESHOLDS,
} = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');
const { protocolStages } = require('../utils/protocolPresentation');

/** Lock the season before its case, matching approval and operation lock order. */
const findCaseForMutation = async (tx, expertId, caseId) => {
    const context = await tx.diseaseCase.findUnique({ where: { id: caseId }, select: { seasonId: true } });
    if (!context) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${context.seasonId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM disease_cases WHERE id = ${caseId}::uuid FOR UPDATE`;
    const diseaseCase = await tx.diseaseCase.findUnique({
        where: { id: caseId },
        include: { season: { include: { pond: { include: { farm: true } } } } },
    });
    if (!diseaseCase) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    if (diseaseCase.expertId !== expertId) throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    if (diseaseCase.status === 'RESOLVED') throw ApiError.badRequest(messages.DISEASE_CASE.ALREADY_RESOLVED);
    return diseaseCase;
};

/** Authorship is historical; operational notices follow the current assignment. */
const currentRecipients = async (tx, seasonId, ownerId) => {
    const technicians = await tx.seasonPersonnelAssignment.findMany({
        where: { seasonId, role: 'TECHNICIAN', unassignedAt: null, account: { status: 'ACTIVE' } },
        select: { accountId: true },
    });
    return [...new Set([ownerId, ...technicians.map(entry => entry.accountId)].filter(Boolean))];
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

    // Normalize multiple severity filter options or comma-separated criteria.
    if (query.severity) {
        const sevs = Array.isArray(query.severity)
            ? query.severity
            : query.severity.includes(',')
                ? query.severity.split(',').map((s) => s.trim()).filter(Boolean)
                : [query.severity];
        where.severity = sevs.length === 1 ? sevs[0] : { in: sevs };
    }

    // Restrict to unresolved cases awaiting expert feedback before pagination.
    if (query.needsResponse === true || query.needsResponse === 'true' || query.status === 'action') {
        const matchingCases = await prisma.$queryRaw`
            SELECT c.id FROM disease_cases c
            WHERE c.expert_id = ${expertId}::uuid
              AND c.status <> 'resolved'::disease_case_status
              AND (
                NOT EXISTS (SELECT 1 FROM disease_case_responses r WHERE r.case_id = c.id)
                OR (
                  SELECT a.role FROM disease_case_responses r
                  JOIN accounts a ON a.id = r.author_id
                  WHERE r.case_id = c.id
                  ORDER BY r.created_at DESC, r.id DESC LIMIT 1
                ) <> 'expert'::account_role
              )
        `;
        const ids = matchingCases.map((r) => r.id);
        where.id = { in: ids };
    }

    // Prioritize clinical urgency by severity rank before ordering by recency.
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
    items.sort((a, b) => ((SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0)) || (new Date(b.updatedAt) - new Date(a.updatedAt)));


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
                    { sequenceOrder: 'asc' },
                    { id: 'asc' },
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

            const stages = protocolStages(proto);

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
                    plannedCount: Math.max(0, totalSchedules - completedCount - cancelledCount),
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
        waterThresholds: WATER_THRESHOLDS[diseaseCase.season.shrimpType] ?? null,
        protocols: protocolsWithMetrics,
        productionHolds: await lifecycle.activeHolds(prisma, diseaseCase.seasonId),
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
        const diseaseCase = await findCaseForMutation(tx, expertId, caseId);

        // Align case lifecycle with response intent while preserving active treatments.
        const isRequestInfo = data.responseType === 'REQUEST_INFO';
        const isInstruction = data.responseType === 'EXPERT_INSTRUCTION';
        const isMonitoring = isInstruction && data.switchToMonitoring === true;
        let nextStatus = null;
        let statusReason = null;
        if (diseaseCase.status === 'WAITING_FOR_INFO' && isMonitoring) {
            throw ApiError.conflict(messages.TREATMENT_PROTOCOL.INFORMATION_PENDING);
        }
        if (data.withdrawRequestId) {
            if (isRequestInfo) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.INFORMATION_PENDING);
            const withdrawn = await tx.diseaseCaseResponse.updateMany({ where: {
                id: data.withdrawRequestId, caseId, responseType: 'REQUEST_INFO',
                OR: [{ requestStatus: 'OPEN' }, { requestStatus: null }],
            }, data: { requestStatus: 'CANCELLED' } });
            if (withdrawn.count !== 1) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.INFORMATION_PENDING);
            if (diseaseCase.status === 'WAITING_FOR_INFO'
                && !await lifecycle.pendingRequests(tx, caseId)) {
                const prior = await tx.diseaseCaseStatusHistory.findFirst({ where: { caseId, toStatus: 'WAITING_FOR_INFO' },
                    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }] });
                if (!['OPEN', 'MONITORING'].includes(prior?.fromStatus)) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.INFORMATION_PENDING);
                nextStatus = prior.fromStatus;
                statusReason = 'Expert thu hồi yêu cầu thông tin có lý do; trở về trạng thái trước khi chờ.';
            }
        }
        if (data.releaseHoldIds?.length) {
            if (!isInstruction) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.STATE);
            const holds = await lifecycle.activeHolds(tx, diseaseCase.seasonId);
            const selected = holds.filter(hold => data.releaseHoldIds.includes(hold.id));
            if (selected.length !== data.releaseHoldIds.length) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.STATE);
            const protocol = await tx.protocol.findUnique({ where: { id: selected[0].protocolId } });
            await lifecycle.release(tx, protocol, expertId, data.message.trim(), selected, now);
            await lifecycle.resumeProduction(tx, diseaseCase.seasonId, now);
        }

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

        // Atomic conditional state transition guarded by expected current status.
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
                requestStatus: isRequestInfo ? 'OPEN' : null,
                replyToResponseId: data.withdrawRequestId ?? null,
                createdAt: now,
            },
            include: {
                author: {
                    select: { id: true, fullName: true, role: true },
                },
            },
        });

        // Notify the Owner and currently assigned technician.
        const ownerId = diseaseCase.season?.pond?.farm?.ownerId;
        const recipients = await currentRecipients(tx, diseaseCase.seasonId, ownerId);

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
                // Buffer notifications for dispatch only after the transaction successfully commits.
                pendingNotifications.push({ recipientId, event: 'notification:new', payload: notif });
            }
        }

        return newResponse;
    });

    // Dispatch buffered notifications outside the database transaction.
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
        const diseaseCase = await findCaseForMutation(tx, expertId, caseId);

        if (diseaseCase.status === 'IN_TREATMENT') {
            throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
        }
        if ((await lifecycle.activeHolds(tx, diseaseCase.seasonId)).length) {
            throw ApiError.conflict(messages.TREATMENT_PROTOCOL.HOLD_RELEASE_REQUIRED);
        }
        if (!['OPEN', 'MONITORING'].includes(diseaseCase.status)
            || await lifecycle.pendingRequests(tx, caseId)) {
            throw ApiError.conflict(messages.TREATMENT_PROTOCOL.INFORMATION_PENDING);
        }

        // Resolve requires all linked treatment schedules to be completed or stopped.
        const activeProtocols = await tx.protocol.findMany({
            where: {
                diseaseCaseId: caseId,
                status: { in: [PROTOCOL_STATUS.DRAFT, PROTOCOL_STATUS.REJECTED, PROTOCOL_STATUS.PENDING_APPROVAL,
                    PROTOCOL_STATUS.APPROVED, PROTOCOL_STATUS.ACTIVE] },
            },
            include: {
                items: { select: { id: true } },
            },
        });

        const pendingProto = activeProtocols.find((p) => ['DRAFT', 'REJECTED', 'PENDING_APPROVAL'].includes(p.status));
        if (pendingProto) {
            throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_PENDING_APPROVAL_BLOCK);
        }

        // An empty rolling window is not evidence that the entire course ended.
        // Approval remains a blocker until an explicit terminal application outcome is stored.
        if (diseaseCase.status === 'IN_TREATMENT'
            || activeProtocols.some(p => ['APPROVED', 'ACTIVE'].includes(p.status))) {
            throw ApiError.badRequest(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
        }

        // Atomic conditional state transition guarded by expected current status.
        const updateCount = await tx.diseaseCase.updateMany({
            where: { id: caseId, expertId, status: { not: 'RESOLVED' } },
            data: {
                status: 'RESOLVED',
                resolutionSummary: summary,
                resolutionReason: 'EXPERT_CONCLUDED',
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

        // Persist the resolution summary in the case response thread.
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
        const recipients = await currentRecipients(tx, diseaseCase.seasonId, ownerId);

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
                // Buffer notifications for dispatch only after the transaction successfully commits.
                pendingNotifications.push({ recipientId, event: 'notification:new', payload: notif });
            }
        }

        return {
            ...diseaseCase,
            status: 'RESOLVED',
            resolutionSummary: summary,
            resolvedBy: expertId,
            resolvedAt: now,
            updatedAt: now,
        };
    });

    // Dispatch buffered notifications outside the database transaction.
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
};
