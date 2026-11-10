const prisma = require('../config/prisma');
const { ApiError, recognitionResult } = require('../utils');
const { messages, DISEASE_CASE_STATUS: STATUS, NOTIFICATION_TYPE, ACCOUNT_ROLE, ACCOUNT_STATUS, SEASON_STATUS, AI_RECOGNITION_STATUS } = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');
const msg = messages.DISEASE_CASE;
const identity = { id: true, fullName: true };
const seasonSelect = {
    id: true, name: true, status: true, shrimpType: true, stockingDate: true,
    pond: { select: { id: true, name: true, farm: { select: { id: true, name: true, ownerId: true } } } },
    personnelAssignments: { where: { unassignedAt: null }, select: {
        accountId: true, role: true, account: { select: { role: true, status: true, managedByOwnerId: true } },
    } },
};
const listSelect = {
    id: true, seasonId: true, title: true, severity: true, status: true, createdAt: true, updatedAt: true,
    description: true, expert: { select: identity }, _count: { select: { responses: true } },
};
const detailSelect = {
    ...listSelect, description: true, reportedBy: true, expertId: true, relatedCaseId: true, aiDiagnosisId: true,
    caseSnapshot: true, resolutionSummary: true, resolvedAt: true,
    reporter: { select: identity },
    expert: { select: identity },
    attachments: { select: { id: true, fileUrl: true, caption: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    responses: { select: { id: true, authorId: true, author: { select: identity }, responseType: true,
        message: true, attachments: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    statusHistory: { select: { id: true, fromStatus: true, toStatus: true, changedBy: true, reason: true, changedAt: true },
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] },
};

const scope = async (tx, accountId, seasonId, writing = false) => {
    // Prisma has no row-lock API; this also serializes concurrent case creation per season.
    if (writing) await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${seasonId}::uuid FOR UPDATE`;
    const season = await tx.aquacultureSeason.findUnique({ where: { id: seasonId }, select: seasonSelect });
    if (!season) throw ApiError.notFound(msg.NOT_FOUND);
    const current = season.personnelAssignments.some(a => a.accountId === accountId && a.role === ACCOUNT_ROLE.TECHNICIAN
        && a.account.role === ACCOUNT_ROLE.TECHNICIAN && a.account.status === ACCOUNT_STATUS.ACTIVE
        && a.account.managedByOwnerId === season.pond.farm.ownerId);
    if (!current) {
        let historicalRead = false;
        if (!writing && [SEASON_STATUS.COMPLETED, SEASON_STATUS.CANCELLED].includes(season.status)) {
            const account = await tx.account.findUnique({ where: { id: accountId }, select: { role: true, status: true, managedByOwnerId: true } });
            historicalRead = account?.role === ACCOUNT_ROLE.TECHNICIAN && account.status === ACCOUNT_STATUS.ACTIVE
                && account.managedByOwnerId === season.pond.farm.ownerId
                && Boolean(await tx.seasonPersonnelAssignment.findFirst({ where: { seasonId, accountId, role: ACCOUNT_ROLE.TECHNICIAN }, select: { id: true } }));
        }
        if (!historicalRead) throw ApiError.forbidden(msg.NO_ASSIGNMENT);
    }
    if (writing && season.status !== SEASON_STATUS.ACTIVE) throw ApiError.forbidden(msg.SEASON_NOT_ACTIVE);
    return season;
};
const findCase = async (tx, seasonId, caseId) => {
    const item = await tx.diseaseCase.findFirst({ where: { id: caseId, seasonId }, select: detailSelect });
    if (!item) throw ApiError.notFound(msg.NOT_FOUND);
    return item;
};
const present = (item, season) => ({ ...item, canRespond: season.status === 'ACTIVE' && item.status !== STATUS.RESOLVED });
const getCase = (accountId, seasonId, caseId) => prisma.$transaction(async (tx) => {
    const season = await scope(tx, accountId, seasonId);
    return present(await findCase(tx, seasonId, caseId), season);
}, { isolationLevel: 'RepeatableRead' });
const listCases = (accountId, seasonId, { page = 1, limit = 20, status, severity, resolved } = {}) =>
    prisma.$transaction(async (tx) => {
        const season = await scope(tx, accountId, seasonId);
        const where = { seasonId, ...(status && { status }), ...(resolved != null && { status: resolved ? STATUS.RESOLVED : { not: STATUS.RESOLVED } }), ...(severity && { severity }) };
        const [data, totalResults, ongoingCount, resolvedCount] = await Promise.all([
            tx.diseaseCase.findMany({ where, select: listSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * limit, take: limit }),
            tx.diseaseCase.count({ where }),
            tx.diseaseCase.count({ where: { seasonId, status: { not: STATUS.RESOLVED } } }),
            tx.diseaseCase.count({ where: { seasonId, status: STATUS.RESOLVED } }),
        ]);
        const existing = await tx.diseaseCase.findFirst({ where: { seasonId, status: { not: STATUS.RESOLVED } }, select: { id: true } });
        return { data, meta: { page, limit, totalResults, ongoingCount, resolvedCount,
            season: { id: season.id, name: season.name, pondName: season.pond.name }, hasNextPage: page * limit < totalResults,
            existingCaseId: existing?.id ?? null, canCreate: season.status === SEASON_STATUS.ACTIVE && !existing } };
    }, { isolationLevel: 'RepeatableRead' });

const mutate = async (operation) => {
    let result;
    try {
        result = await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
        if (['P2034', 'P2025'].includes(error.code)) throw ApiError.conflict(msg.CONFLICT);
        if (error.code === 'P2002') throw ApiError.conflict(msg.EXISTING_CASE);
        if (error.code === 'P2003') throw ApiError.conflict(msg.CONFLICT);
        throw error;
    }
    for (const notification of result.notifications) {
        emitNotification(notification.accountId, 'notification:new', { id: notification.id });
    }
    return result.item;
};
const notify = (tx, item, recipients, type, content) => Promise.all([...new Set(recipients)].map((accountId) =>
    tx.notification.create({ data: { accountId, type, title: item.title, content,
        referenceType: 'disease_case', referenceId: item.id }, select: { id: true, accountId: true } })));

const createCase = (accountId, seasonId, input) => mutate(async (tx) => {
    const season = await scope(tx, accountId, seasonId, true);
    if (await tx.diseaseCase.findFirst({ where: { seasonId, status: { not: STATUS.RESOLVED } }, select: { id: true } })) {
        throw ApiError.conflict(msg.EXISTING_CASE);
    }
    const experts = season.personnelAssignments.filter((a) => a.role === ACCOUNT_ROLE.EXPERT &&
        a.account.role === ACCOUNT_ROLE.EXPERT && a.account.status === ACCOUNT_STATUS.ACTIVE && a.account.managedByOwnerId === season.pond.farm.ownerId);
    if (experts.length !== 1) throw ApiError.conflict(msg.NO_EXPERT);
    if (input.relatedCaseId && !await tx.diseaseCase.findFirst({
        where: { id: input.relatedCaseId, seasonId }, select: { id: true },
    })) throw ApiError.badRequest(msg.INVALID_RELATED_CASE);
    const ai = input.aiDiagnosisId ? await tx.aiDiagnosisLog.findFirst({ where: {
        id: input.aiDiagnosisId, seasonId, requestedBy: accountId, runStatus: 'SUCCESS',
    }, select: { id: true, predictedLabel: true, predictions: true, recommendation: true, createdAt: true } }) : null;
    if (input.aiDiagnosisId && !ai) throw ApiError.badRequest(msg.INVALID_AI);
    const aiRecognition = ai ? recognitionResult(ai) : null;
    const aiSnapshot = ai ? {
        id: ai.id,
        ...aiRecognition,
        recommendation: aiRecognition.recognitionStatus === AI_RECOGNITION_STATUS.RECOGNIZED ? ai.recommendation : null,
        createdAt: ai.createdAt,
    } : null;
    const capturedAt = new Date();
    // Snapshot facts already recorded when the KTV opens the case; later log edits do not rewrite it.
    const [health, water] = await Promise.all([
        tx.shrimpHealthLog.findFirst({ where: { seasonId, isVoided: false, recordedAt: { lte: capturedAt } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { id: true, recordedAt: true,
                avgWeightG: true, mortalityCount: true, estimatedBiomassKg: true, healthStatus: true } }),
        tx.waterQualityLog.findFirst({ where: { seasonId, isVoided: false, recordedAt: { lte: capturedAt } },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { id: true, recordedAt: true,
                ph: true, dissolvedOxygenMgL: true, nh3MgL: true, no2MgL: true } }),
    ]);
    const snapshot = { capturedAt: capturedAt.toISOString(), seasonId, seasonName: season.name,
        pondName: season.pond.name, farmName: season.pond.farm.name,
        shrimpType: season.shrimpType, stockingDate: season.stockingDate,
        healthLogId: health?.id ?? null, healthRecordedAt: health?.recordedAt ?? null,
        waterLogId: water?.id ?? null, waterRecordedAt: water?.recordedAt ?? null,
        avgWeightG: health?.avgWeightG?.toString() ?? null,
        mortalityCount: health?.mortalityCount?.toString() ?? null,
        estimatedBiomassKg: health?.estimatedBiomassKg?.toString() ?? null, healthStatus: health?.healthStatus ?? null,
        ph: water?.ph?.toString() ?? null, doMgL: water?.dissolvedOxygenMgL?.toString() ?? null,
        nh3MgL: water?.nh3MgL?.toString() ?? null, no2MgL: water?.no2MgL?.toString() ?? null,
        ...(aiSnapshot && { aiDiagnosis: aiSnapshot }) };
    const item = await tx.diseaseCase.create({ data: {
        seasonId, reportedBy: accountId, expertId: experts[0].accountId,
        title: input.title, description: input.description, severity: input.severity,
        aiDiagnosisId: input.aiDiagnosisId,
        relatedCaseId: input.relatedCaseId, status: STATUS.OPEN, caseSnapshot: JSON.parse(JSON.stringify(snapshot)),
        attachments: { create: input.attachments.map((fileUrl) => ({ fileUrl, uploadedBy: accountId })) },
        statusHistory: { create: { toStatus: STATUS.OPEN, changedBy: accountId } },
    }, select: detailSelect });
    const notifications = await notify(tx, item, [experts[0].accountId, season.pond.farm.ownerId],
        NOTIFICATION_TYPE.DISEASE_CASE_CREATED, msg.CREATED);
    return { item: present(item, season), notifications };
});

const respond = (accountId, seasonId, caseId, input) => mutate(async (tx) => {
    const season = await scope(tx, accountId, seasonId, true);
    const item = await findCase(tx, seasonId, caseId);
    if (item.status === STATUS.RESOLVED) throw ApiError.forbidden(msg.ALREADY_RESOLVED);
    if (item.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw ApiError.conflict(msg.CONFLICT);
    // PostgreSQL stores microseconds; Prisma Date truncates to milliseconds. Match that entire millisecond.
    // Serializable isolation also detects assignment changes and simultaneous responses before commit.
    const changed = await tx.diseaseCase.updateMany({ where: { id: caseId, seasonId, status: item.status,
        updatedAt: { gte: input.expectedUpdatedAt, lt: new Date(input.expectedUpdatedAt.getTime() + 1) } },
    data: { updatedAt: new Date(Math.max(Date.now(), item.updatedAt.getTime() + 1)) } });
    if (changed.count !== 1) throw ApiError.conflict(msg.CONFLICT);
    await tx.diseaseCaseResponse.create({ data: { caseId, authorId: accountId,
        responseType: input.responseType, message: input.message, attachments: input.attachments } });
    const emergency = input.responseType === 'EMERGENCY_ALERT';
    const experts = season.personnelAssignments.filter((a) => a.role === ACCOUNT_ROLE.EXPERT && a.account.role === ACCOUNT_ROLE.EXPERT && a.account.status === ACCOUNT_STATUS.ACTIVE &&
        a.account.managedByOwnerId === season.pond.farm.ownerId).map((a) => a.accountId);
    const notifications = await notify(tx, item, [...experts, ...(emergency ? [season.pond.farm.ownerId] : [])],
        emergency ? NOTIFICATION_TYPE.EMERGENCY_CASE_UPDATE : NOTIFICATION_TYPE.DISEASE_CASE_RESPONSE,
        emergency ? msg.EMERGENCY : msg.RESPONDED);
    // A KTV supplies evidence; only the Expert orchestrates clinical state transitions.
    return { item: present(await findCase(tx, seasonId, caseId), season), notifications };
});
module.exports = { listCases, getCase, createCase, respond };
