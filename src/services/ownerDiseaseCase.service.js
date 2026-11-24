const prisma = require('../config/prisma');
const caseCare = require('./caseCare.service');
const lifecycle = require('./protocolLifecycle.service');
const { readCaseAssessment } = require('./aiDiagnosis.service');
const {
    AI_LABEL_NAMES, AI_MIN_RECOGNITION_CONFIDENCE, AI_RECOGNITION_STATUS, AI_RUN_STATUS,
    DISEASE_CASE_STATUS, HEALTH_STATUS, PROTOCOL_STATUS, PROTOCOL_TYPE,
    checkWaterThresholds, messages,
} = require('../constants');
const { ApiError } = require('../utils');
const { lifecycleReason } = require('../utils/protocolPresentation');

const { RESOLVED } = DISEASE_CASE_STATUS;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
const WATER_LEGACY_FIELDS = {
    temperatureC: ['temperature_c'],
    ph: [],
    dissolvedOxygenMgL: ['dissolved_oxygen_mg_l', 'doMgL', 'do_mg_l'],
    salinityPpt: ['salinity_ppt'],
    nh3MgL: ['nh3_mg_l'],
    no2MgL: ['no2_mg_l'],
    alkalinityMgLCaCO3: ['alkalinity_mg_l_caco3', 'alkalinity_mg_l_ca_co3'],
    h2sMgL: ['h2s_mg_l'],
};

/**
 * Treat blank or malformed text in a stored snapshot as missing.
 */
const textValue = (value) => typeof value === 'string' ? value.trim() || null : null;
/**
 * Accept nonnegative finite measurements from historical snapshots, including numeric strings.
 */
const numberValue = (value) => {
    if (typeof value !== 'number' && !textValue(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
};
/**
 * Parse a historical snapshot timestamp only when the stored text is a valid date.
 */
const dateValue = (value) => {
    const date = textValue(value);
    return date && Number.isFinite(Date.parse(date)) ? new Date(date) : null;
};

/** Older case snapshots stored confidence as either a probability or a percentage. */
const probabilityValue = (value) => {
    const confidence = numberValue(value);
    const probability = confidence > 1 ? confidence / 100 : confidence;
    return probability !== null && probability <= 1 ? probability : null;
};

/** The case may already carry the human-readable AI assessment from when it was opened. */
const snapshotLabel = (snapshot) => {
    const diagnosis = snapshot?.aiDiagnosis;
    if (diagnosis?.recognitionStatus === AI_RECOGNITION_STATUS.UNRECOGNIZED) return null;
    const label = textValue(diagnosis?.disease) ?? textValue(diagnosis?.label) ?? textValue(diagnosis?.predictedLabel);
    const confidence = probabilityValue(diagnosis?.confidence);
    if (confidence !== null && confidence < AI_MIN_RECOGNITION_CONFIDENCE) return null;
    if (numberValue(diagnosis?.confidence) > 100) return null;
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
const card = (row, responseCount, aiDiagnosis) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    severity: row.severity,
    expertName: row.expert.fullName,
    aiDiagnosis,
    responseCount,
});

/** Prefer the recorded recognition result and fill missing detail from the linked inference. */
const caseAssessment = (snapshot, linked) => {
    const stored = snapshot?.aiDiagnosis;
    const confidence = probabilityValue(stored?.confidence) ?? linked?.confidence ?? null;
    const label = snapshotLabel(snapshot) ?? linked?.predictedLabel ?? null;
    const unrecognized = stored?.recognitionStatus === AI_RECOGNITION_STATUS.UNRECOGNIZED ||
        (confidence !== null && confidence < AI_MIN_RECOGNITION_CONFIDENCE);
    const predictedLabel = unrecognized ? null : label;
    const recognitionStatus = unrecognized ? AI_RECOGNITION_STATUS.UNRECOGNIZED
        : predictedLabel ? AI_RECOGNITION_STATUS.RECOGNIZED
            : linked?.recognitionStatus ?? null;
    const createdAt = dateValue(stored?.createdAt ?? stored?.created_at) ?? linked?.createdAt ?? null;
    if (!recognitionStatus && confidence === null && !createdAt && !linked) return null;

    return {
        predictedLabel,
        recognitionStatus,
        confidence,
        recommendation: predictedLabel ? textValue(linked?.recommendation ?? stored?.recommendation) : null,
        createdAt,
        processingTimeMs: linked?.processingTimeMs ?? null,
        imageUrls: linked?.imageUrls ?? [],
        imageUrlsExpireAt: linked?.imageUrlsExpireAt ?? null,
    };
};

/** Read only the exact historical source when a snapshot predates water log metadata. */
const openingWaterSource = async (client, row) => {
    const snapshot = row.caseSnapshot;
    const water = snapshot?.waterIndicators;
    const id = textValue(snapshot?.waterLogId ?? snapshot?.water_log_id);
    if (!id || !UUID_PATTERN.test(id) || (water && Object.hasOwn(water, 'recordedByName') &&
        Object.hasOwn(water, 'note'))) return null;
    const source = await client.waterQualityLog.findFirst({
        where: {
            id, seasonId: row.season.id, recordedAt: { lte: row.createdAt },
            createdAt: { lte: row.createdAt },
        },
        select: {
            recordedBy: true, recordedAt: true, note: true,
            ...Object.fromEntries(Object.keys(WATER_LEGACY_FIELDS).map((field) => [field, true])),
        },
    });
    if (!source) return null;
    const recorder = await client.account.findUnique({
        where: { id: source.recordedBy },
        select: { fullName: true },
    });
    return { ...source, recordedByName: recorder?.fullName };
};

/** Older case snapshots use waterIndicators, snake_case measurements and a seven-day loss count. */
const openingSnapshot = (snapshot, shrimpType, source) => {
    const health = snapshot?.shrimpHealth ?? snapshot?.health ?? snapshot;
    const water = snapshot?.waterIndicators ?? snapshot?.waterQuality ?? snapshot?.water ?? snapshot;
    const waterMetrics = Object.fromEntries(Object.entries(WATER_LEGACY_FIELDS).map(([field, aliases]) => {
        const keys = [field, ...aliases];
        const value = keys.map((key) => numberValue(water?.[key] ?? snapshot?.[key]))
            .find((value) => value !== null);
        return [field, value ?? (source?.[field] == null ? null : Number(source[field]))];
    }));
    const metrics = {
        avgWeightG: numberValue(health?.avgWeightG ?? health?.avg_weight_g),
        mortalityCount: numberValue(health?.mortalityCount ?? health?.mortality_count ??
            health?.mortality7d ?? health?.mortality_7d),
        ...waterMetrics,
    };
    const healthStatus = textValue(health?.healthStatus ?? health?.health_status)?.toUpperCase();
    const status = Object.values(HEALTH_STATUS).includes(healthStatus) ? healthStatus : null;
    const capturedAt = dateValue(snapshot?.capturedAt ?? snapshot?.captured_at ??
        health?.recordedAt ?? health?.recorded_at ?? water?.recordedAt ?? water?.recorded_at);
    // Use source-specific timestamps so the case capture time cannot stand in for a reading.
    const healthRecordedAt = dateValue(snapshot?.healthRecordedAt ?? snapshot?.health_recorded_at) ??
        (health === snapshot ? null : dateValue(health?.recordedAt ?? health?.recorded_at));
    const waterRecordedAt = dateValue(snapshot?.waterRecordedAt ?? snapshot?.water_recorded_at) ??
        (water === snapshot ? null : dateValue(water?.recordedAt ?? water?.recorded_at)) ??
        source?.recordedAt ?? null;
    const waterRecordedByName = textValue(water?.recordedByName ?? water?.recorded_by_name ??
        snapshot?.waterRecordedByName) ?? source?.recordedByName ?? null;
    const waterNote = textValue(water === snapshot ? snapshot?.waterNote : water?.note) ??
        textValue(source?.note);
    const signs = snapshot?.observedSigns ?? snapshot?.symptoms;
    const note = textValue(snapshot?.note) ?? textValue(health?.note) ??
        (Array.isArray(signs) ? signs.map(textValue).filter(Boolean).join(', ') || null : textValue(signs));
    if (!capturedAt && !status && !note && !healthRecordedAt &&
        !waterRecordedAt && !waterRecordedByName && !waterNote &&
        Object.values(metrics).every((value) => value === null)) {
        return null;
    }

    const exceededWaterMetrics = checkWaterThresholds(shrimpType, waterMetrics).map(({ field }) => field);
    return {
        capturedAt, healthStatus: status, note, ...metrics, exceededWaterMetrics,
        healthRecordedAt, waterRecordedAt, waterRecordedByName, waterNote,
    };
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
        data: rows.map((row) => card(
            row,
            row._count.responses,
            snapshotLabel(row.caseSnapshot) ?? labels.get(row.aiDiagnosisId) ?? null,
        )),
        meta: {
            page, limit, totalResults, totalPages, hasNextPage: page < totalPages,
            activeCount, resolvedCount, seasonName: season.name, pondName: season.pond.name,
        },
    };
}, { isolationLevel: 'RepeatableRead' });

/** Merge status changes and replies oldest-first, with changes first on equal timestamps. */
const caseTimeline = (row) => [
    ...row.statusHistory.map(({ fromStatus, toStatus, changedAt, reason, changer }) => ({
        kind: 'status', fromStatus, toStatus, at: changedAt, message: lifecycleReason(reason), authorName: changer?.fullName ?? 'Hệ thống',
    })),
    ...row.responses.map(({ responseType, createdAt, message, author, careAction }) => ({
        kind: 'response', responseType, at: createdAt, message, authorName: author.fullName, authorRole: author.role, careAction,
    })),
].sort((first, second) => first.at - second.at);

/** Mask foreign IDs and return only owner-visible, submitted treatment protocol versions. */
const detail = (ownerId, caseId) => prisma.$transaction(async (client) => {
    const row = await client.diseaseCase.findFirst({
        where: { id: caseId, season: { pond: { farm: { ownerId } } } },
        select: {
            ...CARD_SELECT,
            reportedBy: true,
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
                    id: true, responseType: true, createdAt: true, message: true,
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
    const [linkedAssessment, waterSource] = await Promise.all([
        readCaseAssessment(client, { ...row, seasonId: season.id }),
        openingWaterSource(client, row),
    ]);
    const aiAssessment = caseAssessment(row.caseSnapshot, linkedAssessment);
    return {
        card: card(row, row.responses.length, aiAssessment?.predictedLabel ?? null),
        aiAssessment,
        seasonName: season.name,
        pondName: season.pond.name,
        farmName: season.pond.farm.name,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        resolutionSummary: lifecycleReason(row.resolutionSummary),
        reporterName: row.reporter.fullName,
        snapshot: openingSnapshot(row.caseSnapshot, season.shrimpType, waterSource),
        attachments: row.attachments.map(({ uploader, ...attachment }) => ({
            ...attachment, uploaderName: uploader.fullName,
        })),
        protocols: row.protocols,
        timeline: caseTimeline({ ...row, responses: await caseCare.annotate(client, row.responses) }),
        productionPaused: await lifecycle.productionPaused(client, season.id),
    };
}, { isolationLevel: 'RepeatableRead' });

module.exports = { list, detail };
