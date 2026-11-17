const prisma = require('../config/prisma');
const mutate = require('./caseTransaction.service');
const lifecycle = require('./protocolLifecycle.service');
const drafts = require('./protocolDraft.service');
const caseCare = require('./caseCare.service');
const { ApiError } = require('../utils');
const { messages, NOTIFICATION_TYPE, WATER_THRESHOLDS } = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');
const { protocolStages } = require('../utils/protocolPresentation');

const SEVERITY_WEIGHT = {
    CRITICAL: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
};

/** Lock the season before its case, matching approval and operation lock order. */
const findCaseForMutation = async (tx, expertId, caseId) => {
    const context = await tx.diseaseCase.findUnique({
        where: { id: caseId },
        select: { seasonId: true },
    });
    if (!context) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${context.seasonId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM disease_cases WHERE id = ${caseId}::uuid FOR UPDATE`;
    const diseaseCase = await tx.diseaseCase.findUnique({
        where: { id: caseId },
        include: { season: { include: { pond: { include: { farm: true } } } } },
    });
    if (!diseaseCase) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    if (diseaseCase.expertId !== expertId)
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    if (diseaseCase.status === 'RESOLVED')
        throw ApiError.badRequest(messages.DISEASE_CASE.ALREADY_RESOLVED);
    const assigned = await tx.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId: diseaseCase.seasonId,
            accountId: expertId,
            role: 'EXPERT',
            unassignedAt: null,
            account: {
                role: 'EXPERT',
                status: 'ACTIVE',
                managedByOwnerId: diseaseCase.season.pond.farm.ownerId,
            },
        },
        select: { id: true },
    });
    if (
        !assigned ||
        diseaseCase.season.status !== 'ACTIVE' ||
        diseaseCase.season.pond.farm.status !== 'ACTIVE'
    ) {
        throw ApiError.forbidden(messages.DISEASE_CASE.NOT_ASSIGNED);
    }
    return diseaseCase;
};

/** Authorship is historical; operational notices follow the current assignment. */
const currentRecipients = async (tx, seasonId, ownerId) => {
    const technicians = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId,
            role: 'TECHNICIAN',
            unassignedAt: null,
            account: { role: 'TECHNICIAN', status: 'ACTIVE', managedByOwnerId: ownerId },
        },
        select: { accountId: true },
    });
    return [...new Set([ownerId, ...technicians.map((entry) => entry.accountId)].filter(Boolean))];
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
                      {
                          season: {
                              pond: {
                                  name: { contains: query.search.trim(), mode: 'insensitive' },
                              },
                          },
                      },
                      {
                          season: {
                              pond: {
                                  farm: {
                                      name: { contains: query.search.trim(), mode: 'insensitive' },
                                  },
                              },
                          },
                      },
                      {
                          reporter: {
                              fullName: { contains: query.search.trim(), mode: 'insensitive' },
                          },
                      },
                  ],
              }
            : {}),
    };

    // Normalize multiple severity filter options or comma-separated criteria.
    if (query.severity) {
        const sevs = Array.isArray(query.severity)
            ? query.severity
            : query.severity.includes(',')
              ? query.severity
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
              : [query.severity];
        where.severity = sevs.length === 1 ? sevs[0] : { in: sevs };
    }

    // Restrict to unresolved cases awaiting expert feedback before pagination.
    if (
        query.needsResponse === true ||
        query.needsResponse === 'true' ||
        query.status === 'action'
    ) {
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
            orderBy: [{ severity: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
            skip,
            take: limit,
        }),
    ]);

    const items = rawCases.map((c) => {
        const lastResp = c.responses?.[0];
        const needsResponse =
            c.status !== 'RESOLVED' && (!lastResp || lastResp.author?.role !== 'EXPERT');

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
    items.sort(
        (a, b) =>
            (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0) ||
            new Date(b.updatedAt) - new Date(a.updatedAt),
    );

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
                orderBy: [{ sequenceOrder: 'asc' }, { id: 'asc' }],
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

    const protoChangers =
        protoChangerIds.size > 0
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
                treatmentStartAt: proto.treatmentStartAt,
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
                    progressPct:
                        totalSchedules > 0
                            ? Math.round((completedCount / totalSchedules) * 100)
                            : 0,
                },
            };
        }),
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
        ...(await caseCare.context(prisma, diseaseCase)),
        responses: await caseCare.annotate(prisma, diseaseCase.responses),
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
                          latestHealth.avgWeightG != null ? Number(latestHealth.avgWeightG) : null,
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

const notifyParticipants = async (tx, diseaseCase, title, content, type) => {
    const recipients = await currentRecipients(
        tx,
        diseaseCase.seasonId,
        diseaseCase.season.pond.farm.ownerId,
    );
    return Promise.all(
        recipients
            .filter((id) => id !== diseaseCase.expertId)
            .map((accountId) =>
                tx.notification.create({
                    data: {
                        accountId,
                        title,
                        content,
                        type,
                        referenceType: 'disease_case',
                        referenceId: diseaseCase.id,
                    },
                }),
            ),
    );
};

/** Conversation does not change clinical state or production holds. */
const respond = async (expertId, caseId, data) => {
    const result = await mutate(async (tx) => {
        const diseaseCase = await findCaseForMutation(tx, expertId, caseId);
        if (
            data.replyToResponseId &&
            !(await tx.diseaseCaseResponse.count({
                where: { id: data.replyToResponseId, caseId },
            }))
        )
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.REQUEST_REPLY_INVALID);
        const now = new Date();
        await tx.diseaseCase.update({ where: { id: caseId }, data: { updatedAt: now } });
        const response = await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'NORMAL',
                message: data.message.trim(),
                attachments: data.attachments || [],
                replyToResponseId: data.replyToResponseId ?? null,
                createdAt: now,
            },
            include: { author: { select: { id: true, fullName: true, role: true } } },
        });
        const notifications = await notifyParticipants(
            tx,
            diseaseCase,
            'Phản hồi mới từ Chuyên gia',
            'Chuyên gia đã phản hồi về ca bệnh "' +
                diseaseCase.title +
                '": ' +
                data.message.slice(0, 100),
            NOTIFICATION_TYPE.DISEASE_CASE_RESPONSE,
        );
        return { response, notifications };
    });
    dispatchNotifications(result.notifications);
    return result.response;
};

const dispatchNotifications = (notifications) => {
    for (const notification of notifications) {
        try {
            emitNotification(notification.accountId, 'notification:new', notification);
        } catch {
            // Persisted notifications remain available if socket delivery fails.
        }
    }
};

/** Apply a confirmed care decision to the current suspension and publish notices only after commit. */
const care = async (expertId, caseId, data) => {
    if (!['MONITOR', 'RESUME_PRODUCTION'].includes(data.action))
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.CARE_NOT_PENDING);
    const result = await mutate(async (tx) => {
        let diseaseCase = await findCaseForMutation(tx, expertId, caseId);
        const lifecycleNotices = await lifecycle.reconcile(tx, diseaseCase.seasonId);
        diseaseCase = await findCaseForMutation(tx, expertId, caseId);
        if (new Date(data.expectedUpdatedAt).getTime() !== diseaseCase.updatedAt.getTime()) {
            throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
        }
        if (diseaseCase.status === 'IN_TREATMENT')
            throw ApiError.conflict(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
        const holds = await lifecycle.activeHolds(tx, diseaseCase.seasonId);
        const now = new Date();
        const reason = data.reason.trim();
        const context = await caseCare.context(tx, diseaseCase, now);
        if (!context.care.available || data.episodeId !== context.care.episodeId) {
            throw ApiError.conflict(
                context.care.unavailableReason || messages.TREATMENT_PROTOCOL.CARE_NOT_PENDING,
            );
        }
        if (data.action === 'MONITOR' && !context.care.canMonitor)
            throw ApiError.conflict(messages.TREATMENT_PROTOCOL.CARE_MONITOR_RECORDED);
        if (data.action === 'RESUME_PRODUCTION') {
            if (!data.confirmResume)
                throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.CARE_CONFIRM_REQUIRED);
            if (!context.care.production.canResume)
                throw ApiError.conflict(context.care.production.message);
            // Approval in another tab must not substitute a plan the Expert has not confirmed.
            if (
                data.expectedProduction?.id !== context.care.production.protocolId ||
                new Date(data.expectedProduction?.updatedAt).getTime() !==
                    context.care.production.protocolUpdatedAt.getTime()
            ) {
                throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
            }
            const selected = new Set(data.releaseHoldIds || []);
            const confirmedHolds = holds.filter((row) => selected.has(row.id));
            if (
                confirmedHolds.length !== selected.size ||
                selected.size !== context.care.holdIds.length ||
                context.care.holdIds.some((id) => !selected.has(id))
            ) {
                throw ApiError.conflict(messages.TREATMENT_PROTOCOL.HOLD_CHANGED);
            }
            if (confirmedHolds.length) {
                const protocol = await tx.protocol.findUnique({
                    where: { id: confirmedHolds[0].protocolId },
                });
                await lifecycle.release(tx, protocol, expertId, reason, confirmedHolds, now);
            }
            await lifecycle.resumeProduction(tx, diseaseCase.seasonId, now);
            if (
                !(await tx.protocol.count({
                    where: { id: context.care.production.protocolId, status: 'ACTIVE' },
                }))
            ) {
                throw ApiError.conflict(messages.TREATMENT_PROTOCOL.CARE_PRODUCTION_INVALID);
            }
        }
        await lifecycle.changeCase(tx, diseaseCase, 'MONITORING', expertId, reason, now);
        await tx.diseaseCase.update({ where: { id: caseId }, data: { updatedAt: now } });
        const response = await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'NORMAL',
                message:
                    (data.action === 'MONITOR'
                        ? 'Tiếp tục theo dõi, tạm hoãn phác đồ nuôi: '
                        : 'Cho phép phác đồ nuôi chạy tiếp: ') + reason,
                attachments: [],
                createdAt: now,
            },
        });
        const source = await tx.protocol.findUnique({
            where: { id: holds.find((row) => row.id === context.care.episodeId).protocolId },
        });
        await caseCare.record(
            tx,
            source,
            expertId,
            data.action,
            context.care.episodeId,
            response.id,
            context.care.holdIds,
            reason,
            now,
        );
        const notifications = await notifyParticipants(
            tx,
            diseaseCase,
            'Chuyên gia đã cập nhật hướng chăm sóc',
            diseaseCase.title + ': ' + reason.slice(0, 100),
            NOTIFICATION_TYPE.DISEASE_CASE_MONITORING,
        );
        return {
            data: {
                status: 'MONITORING',
                productionHolds: await lifecycle.activeHolds(tx, diseaseCase.seasonId),
                productionActive: Boolean(
                    await tx.protocol.count({
                        where: {
                            seasonId: diseaseCase.seasonId,
                            protocolType: 'PRODUCTION',
                            status: 'ACTIVE',
                        },
                    }),
                ),
            },
            notifications: [...lifecycleNotices, ...notifications],
            seasonId: diseaseCase.seasonId,
        };
    });
    dispatchNotifications(result.notifications);
    require('../jobs').requestSeason(result.seasonId);
    return result.data;
};

/**
 * Close the case after treatment and production-suspension guards pass.
 * Cancel unapplied plans or remove an unpublished final draft in the same transaction.
 */
const resolve = async (expertId, caseId, data) => {
    if (!data.resolutionSummary || !data.resolutionSummary.trim()) {
        throw ApiError.badRequest(messages.DISEASE_CASE.RESOLUTION_SUMMARY_REQUIRED);
    }

    const summary = data.resolutionSummary.trim();
    const pendingNotifications = [];

    const result = await mutate(async (tx) => {
        pendingNotifications.length = 0;
        let diseaseCase = await findCaseForMutation(tx, expertId, caseId);
        pendingNotifications.push(...(await lifecycle.reconcile(tx, diseaseCase.seasonId)));
        diseaseCase = await findCaseForMutation(tx, expertId, caseId);
        const now = new Date();
        if (diseaseCase.status === 'IN_TREATMENT')
            throw ApiError.conflict(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
        if (
            data.expectedUpdatedAt &&
            new Date(data.expectedUpdatedAt).getTime() !== diseaseCase.updatedAt.getTime()
        ) {
            throw ApiError.conflict(messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
        }
        const context = await caseCare.context(tx, diseaseCase, now);
        if (context.resolution.blockedReason)
            throw ApiError.conflict(context.resolution.blockedReason);
        if (context.resolution.confirmWithoutProduction) {
            // Missing calculation inputs never qualify as an exhausted production plan.
            if (!data.confirmWithoutProduction || !data.expectedUpdatedAt)
                throw ApiError.conflict(messages.TREATMENT_PROTOCOL.CARE_CLOSE_CONFIRM_REQUIRED);
            const holds = context.productionHolds.filter((row) =>
                context.care.holdIds.includes(row.id),
            );
            const source = await tx.protocol.findUnique({ where: { id: holds.at(-1).protocolId } });
            await lifecycle.release(
                tx,
                source,
                expertId,
                'Khép ca; không còn lịch nuôi để tiếp tục.',
                holds,
                now,
            );
        }
        const protocols = await tx.protocol.findMany({
            where: {
                diseaseCaseId: caseId,
                status: { in: ['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE'] },
            },
            orderBy: { versionNo: 'desc' },
        });
        if (protocols.some((row) => row.status === 'ACTIVE'))
            throw ApiError.conflict(messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
        for (const protocol of protocols) {
            if (await drafts.tryRemove(tx, protocol)) continue;
            await lifecycle.transition(
                tx,
                protocol,
                'CANCELLED',
                'PLAN_CANCELLED',
                expertId,
                ('Ca bệnh đã được Expert khép: ' + summary).slice(0, 500),
                { diseaseCaseId: caseId },
                now,
            );
            await lifecycle.cancelPlanned(
                tx,
                protocol.id,
                'TREATMENT_ABORTED',
                'Khóa kế hoạch chưa áp dụng vì ca bệnh đã được khép.',
                expertId,
                now,
            );
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
        const resolutionResponse = await tx.diseaseCaseResponse.create({
            data: {
                caseId,
                authorId: expertId,
                responseType: 'RESOLUTION',
                message: summary.slice(0, 500),
                attachments: [],
                createdAt: now,
            },
        });

        if (context.resolution.confirmWithoutProduction) {
            const source = await tx.protocol.findUnique({
                where: {
                    id: context.productionHolds.find((row) => row.id === context.care.episodeId)
                        .protocolId,
                },
            });
            await caseCare.record(
                tx,
                source,
                expertId,
                'CLOSE_WITHOUT_PRODUCTION',
                context.care.episodeId,
                resolutionResponse.id,
                context.care.holdIds,
                summary,
                now,
            );
        }

        pendingNotifications.push(
            ...(await notifyParticipants(
                tx,
                diseaseCase,
                'Ca bệnh đã được đánh dấu giải quyết',
                'Chuyên gia đã kết luận ca bệnh "' +
                    diseaseCase.title +
                    '": ' +
                    summary.slice(0, 100),
                NOTIFICATION_TYPE.DISEASE_CASE_RESOLVED,
            )),
        );

        return {
            ...diseaseCase,
            status: 'RESOLVED',
            resolutionSummary: summary,
            resolutionReason: 'EXPERT_CONCLUDED',
            resolvedBy: expertId,
            resolvedAt: now,
            updatedAt: now,
        };
    });

    dispatchNotifications(pendingNotifications);

    return result;
};

module.exports = { list, detail, respond, care, resolve };
