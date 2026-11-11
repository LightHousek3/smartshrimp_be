const prisma = require('../config/prisma');
const {
    AI_LABEL_NAMES, AI_MIN_RECOGNITION_CONFIDENCE, AI_RUN_STATUS,
    DISEASE_CASE_STATUS, HEALTH_STATUS, PROTOCOL_STATUS, PROTOCOL_TYPE,
    checkWaterThresholds, messages,
} = require('../constants');
const { ApiError } = require('../utils');

const { RESOLVED } = DISEASE_CASE_STATUS;
const NAME_SELECT = { select: { fullName: true } };
const CARD_SELECT = {
    id: true,
    title: true,
    description: true,
    status: true,
    severity: true,
    caseSnapshot: true,
    aiDiagnosisId: true,
    expert: NAME_SELECT,
};

const textValue = (value) => typeof value === 'string' ? value.trim() || null : null;
const numberValue = (value) => {
    if (typeof value !== 'number' && !textValue(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
};
const dateValue = (value) => {
    const date = textValue(value);
    return date && Number.isFinite(Date.parse(date)) ? new Date(date) : null;
};

/** The case may already carry the human-readable AI assessment from when it was opened. */
const snapshotLabel = (snapshot) => {
    const diagnosis = snapshot?.aiDiagnosis;
    const label = textValue(diagnosis?.disease) ?? textValue(diagnosis?.label);
    const confidence = numberValue(diagnosis?.confidence);
    const probability = confidence > 1 ? confidence / 100 : confidence;
    if (probability !== null && (probability < AI_MIN_RECOGNITION_CONFIDENCE || probability > 1)) return null;
    return label && (Object.hasOwn(AI_LABEL_NAMES, label) ? AI_LABEL_NAMES[label] : label);
};

/** Resolve linked AI labels in a single, season-scoped query and apply the recognition policy. */
const aiLabels = async (client, seasonId, rows) => {
    const ids = [...new Set(rows
        .filter((row) => row.aiDiagnosisId && !snapshotLabel(row.caseSnapshot))
        .map((row) => row.aiDiagnosisId))];
    if (!ids.length) return new Map();

    const diagnoses = await client.aiDiagnosisLog.findMany({
        where: { id: { in: ids }, seasonId, runStatus: AI_RUN_STATUS.SUCCESS },
        select: { id: true, predictedLabel: true, confidence: true, predictions: true },
    });
    return new Map(diagnoses.map((row) => [
        row.id,
        Number(row.predictions?.[0]?.probability ?? row.confidence) >= AI_MIN_RECOGNITION_CONFIDENCE &&
            Object.hasOwn(AI_LABEL_NAMES, row.predictedLabel)
            ? AI_LABEL_NAMES[row.predictedLabel]
            : null,
    ]));
};

/** Keep the case card identical in list and detail without exposing raw snapshots or accounts. */
const card = (row, labels, responseCount) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    expertName: row.expert.fullName,
    aiDiagnosis: snapshotLabel(row.caseSnapshot) ?? labels.get(row.aiDiagnosisId) ?? null,
    responseCount,
});

/** Older case snapshots use waterIndicators, snake_case measurements and a seven-day loss count. */
const openingSnapshot = (snapshot, shrimpType) => {
    const health = snapshot?.shrimpHealth ?? snapshot?.health ?? snapshot;
    const water = snapshot?.waterIndicators ?? snapshot?.waterQuality ?? snapshot?.water ?? snapshot;
    const metrics = {
        avgWeightG: numberValue(health?.avgWeightG ?? health?.avg_weight_g),
        mortalityCount: numberValue(health?.mortalityCount ?? health?.mortality_count ??
            health?.mortality7d ?? health?.mortality_7d),
        ph: numberValue(water?.ph),
        no2MgL: numberValue(water?.no2MgL ?? water?.no2_mg_l),
        nh3MgL: numberValue(water?.nh3MgL ?? water?.nh3_mg_l),
    };
    const healthStatus = textValue(health?.healthStatus ?? health?.health_status)?.toUpperCase();
    const status = Object.values(HEALTH_STATUS).includes(healthStatus) ? healthStatus : null;
    const capturedAt = dateValue(snapshot?.capturedAt ?? snapshot?.captured_at ??
        health?.recordedAt ?? health?.recorded_at ?? water?.recordedAt ?? water?.recorded_at);
    const signs = snapshot?.observedSigns ?? snapshot?.symptoms;
    const note = textValue(snapshot?.note) ?? textValue(health?.note) ??
        (Array.isArray(signs) ? signs.map(textValue).filter(Boolean).join(', ') || null : textValue(signs));
    if (!capturedAt && !status && !note && Object.values(metrics).every((value) => value === null)) {
        return null;
    }

    const exceeded = checkWaterThresholds(shrimpType, metrics).map(({ field }) => field);
    return { capturedAt, healthStatus: status, note, ...metrics, exceededWaterMetrics: exceeded };
};

/** Read the list and both counts from the same database snapshot during status transitions. */
const list = (ownerId, { seasonId, resolved, page, limit }) => prisma.$transaction(async (client) => {
    const season = await client.aquacultureSeason.findFirst({
        where: { id: seasonId, pond: { farm: { ownerId } } },
        select: { name: true, pond: { select: { name: true } } },
    });
    if (!season) throw ApiError.notFound(messages.SEASON.NOT_FOUND);

    const [rows, counts] = await Promise.all([
        client.diseaseCase.findMany({
            where: { seasonId, status: resolved ? RESOLVED : { not: RESOLVED } },
            select: { ...CARD_SELECT, _count: { select: { responses: true } } },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        client.diseaseCase.groupBy({ by: ['status'], where: { seasonId }, _count: { _all: true } }),
    ]);
    const labels = await aiLabels(client, seasonId, rows);
    const resolvedCount = counts.find(({ status }) => status === RESOLVED)?._count._all ?? 0;
    const activeCount = counts.reduce((sum, entry) => sum + entry._count._all, 0) - resolvedCount;
    const totalResults = resolved ? resolvedCount : activeCount;
    const totalPages = Math.ceil(totalResults / limit);

    return {
        data: rows.map((row) => card(row, labels, row._count.responses)),
        meta: {
            page, limit, totalResults, totalPages, hasNextPage: page < totalPages,
            activeCount, resolvedCount, seasonName: season.name, pondName: season.pond.name,
        },
    };
}, { isolationLevel: 'RepeatableRead' });

/** Merge status changes and replies oldest-first, with changes first on equal timestamps. */
const caseTimeline = (row) => [
    ...row.statusHistory.map(({ fromStatus, toStatus, changedAt, reason, changer }) => ({
        kind: 'status', fromStatus, toStatus, at: changedAt, message: reason, authorName: changer.fullName,
    })),
    ...row.responses.map(({ responseType, createdAt, message, author }) => ({
        kind: 'response', responseType, at: createdAt, message, authorName: author.fullName, authorRole: author.role,
    })),
].sort((first, second) => first.at - second.at);

/** Mask foreign IDs and return only owner-visible, submitted treatment protocol versions. */
const detail = (ownerId, caseId) => prisma.$transaction(async (client) => {
    const row = await client.diseaseCase.findFirst({
        where: { id: caseId, season: { pond: { farm: { ownerId } } } },
        select: {
            ...CARD_SELECT,
            createdAt: true,
            updatedAt: true,
            resolutionSummary: true,
            reporter: NAME_SELECT,
            season: {
                select: {
                    id: true, name: true, shrimpType: true,
                    pond: { select: { name: true, farm: { select: { name: true } } } },
                },
            },
            attachments: {
                select: { caption: true, mediaType: true, fileUrl: true, createdAt: true, uploader: NAME_SELECT },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
            protocols: {
                where: {
                    protocolType: PROTOCOL_TYPE.TREATMENT,
                    status: { not: PROTOCOL_STATUS.DRAFT },
                    submittedAt: { not: null },
                    season: { pond: { farm: { ownerId } } },
                },
                select: { id: true, title: true, summary: true, versionNo: true, status: true },
                orderBy: [{ versionNo: 'desc' }, { id: 'desc' }],
            },
            responses: {
                select: {
                    responseType: true, createdAt: true, message: true,
                    author: { select: { fullName: true, role: true } },
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
            statusHistory: {
                select: { fromStatus: true, toStatus: true, changedAt: true, reason: true, changer: NAME_SELECT },
                orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
            },
        },
    });
    if (!row) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);

    const { season } = row;
    const labels = await aiLabels(client, season.id, [row]);
    return {
        card: card(row, labels, row.responses.length),
        seasonName: season.name,
        pondName: season.pond.name,
        farmName: season.pond.farm.name,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        resolutionSummary: row.resolutionSummary,
        reporterName: row.reporter.fullName,
        snapshot: openingSnapshot(row.caseSnapshot, season.shrimpType),
        attachments: row.attachments.map(({ uploader, ...attachment }) => ({
            ...attachment, uploaderName: uploader.fullName,
        })),
        protocols: row.protocols,
        timeline: caseTimeline(row),
    };
}, { isolationLevel: 'RepeatableRead' });

module.exports = { list, detail };
