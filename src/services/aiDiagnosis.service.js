const { randomUUID, createHash } = require('node:crypto');
const axios = require('axios');
const Joi = require('joi');
const config = require('../config');
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const { ApiError, recognitionResult } = require('../utils');
const sign = require('../utils/cloudinarySignature');
const {
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    PERSONNEL_ROLE,
    SEASON_STATUS,
    AI_RUN_STATUS,
    AI_RECOGNITION_STATUS,
    AI_LABELS,
    AI_LABEL_NAMES,
    AI_LIMITS,
    AI_IMAGE_TYPES,
    messages,
} = require('../constants');
const text = messages.AI_DIAGNOSIS;

// Account and season access ---------------------------------------------------

/** Build the current technician-assignment predicate used by every history query. */
const assignmentWhere = (accountId) => ({
    accountId,
    role: PERSONNEL_ROLE.TECHNICIAN,
    unassignedAt: null,
});

/** Restrict results to the requesting technician and a currently assigned season. */
const scopeWhere = (accountId, seasonId) => ({
    requestedBy: accountId,
    seasonId,
    season: { personnelAssignments: { some: assignmentWhere(accountId) } },
});

/** Check Account, season and assignment through the supplied Prisma client; writes require ACTIVE. */
const requireScope = async (db, accountId, seasonId, writing = false) => {
    const account = await db.account.findUnique({
        where: { id: accountId },
        select: { role: true, status: true },
    });
    if (account?.role !== ACCOUNT_ROLE.TECHNICIAN || account.status !== ACCOUNT_STATUS.ACTIVE) {
        throw ApiError.forbidden(text.ACCOUNT_UNAVAILABLE);
    }
    const season = await db.aquacultureSeason.findUnique({
        where: { id: seasonId },
        select: { status: true },
    });
    if (!season) throw ApiError.notFound(text.SEASON_NOT_FOUND);
    const assignment = await db.seasonPersonnelAssignment.findFirst({
        where: { seasonId, ...assignmentWhere(accountId) },
        select: { id: true },
    });
    if (!assignment) throw ApiError.forbidden(text.ASSIGNMENT_REQUIRED);
    if (writing && season.status !== SEASON_STATUS.ACTIVE) {
        throw ApiError.forbidden(text.ACTIVE_SEASON_REQUIRED);
    }
};

/** Reject inaccessible seasons before middleware buffers a multipart body. */
const assertCanCreateDiagnosis = (accountId, seasonId) => requireScope(prisma, accountId, seasonId, true);

// Cloudinary original-image storage ------------------------------------------

/** Require valid server-side Cloudinary credentials without leaking configuration values. */
const storageSettings = () => {
    const value = config.cloudinary;
    if (!value?.cloudName || !value.apiKey || !value.apiSecret || !/^[a-zA-Z0-9_-]+$/.test(value.cloudName)) {
        throw new ApiError(503, text.STORAGE_UNAVAILABLE);
    }
    return value;
};

/** Use raw storage to preserve original bytes and alpha rather than transforming inference inputs. */
const storageEndpoint = (action) => `https://api.cloudinary.com/v1_1/${storageSettings().cloudName}/raw/${action}`;

/** Sign server-controlled Cloudinary parameters; never send the API secret to the caller. */
const signedStorageParams = (params) => {
    const settings = storageSettings();
    const signature = sign(params, settings.apiSecret);
    return { ...params, api_key: settings.apiKey, signature };
};

/** Generate an immutable asset key within a server-generated diagnosis namespace. */
const imageKey = (id, index, file) => `smartshrimp/ai-diagnoses/${id}/${index}.${AI_IMAGE_TYPES[file.mimetype]}`;

/** Upload one private original and verify its identity, resource type, version and byte count. */
const uploadImage = async (storageKey, file) => {
    const form = new FormData();
    const params = signedStorageParams({
        public_id: storageKey,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'authenticated',
        overwrite: 'false',
    });
    Object.entries(params).forEach(([key, value]) => form.append(key, value));
    // Raw assets retain the exact bytes sent to inference, including an existing alpha channel.
    form.append('file', new Blob([file.buffer], { type: file.mimetype }), storageKey.split('/').pop());
    try {
        const { data } = await axios.post(storageEndpoint('upload'), form, {
            timeout: AI_LIMITS.STORAGE_TIMEOUT_MS,
            maxRedirects: 0,
            maxBodyLength: AI_LIMITS.MAX_FILE_BYTES + AI_LIMITS.MULTIPART_OVERHEAD_BYTES,
            maxContentLength: AI_LIMITS.MAX_RESPONSE_BYTES,
        });
        const expectedPrefix = `https://res.cloudinary.com/${storageSettings().cloudName}/raw/authenticated/`;
        if (
            data.public_id !== storageKey || data.resource_type !== 'raw' || data.type !== 'authenticated' ||
            !Number.isSafeInteger(data.version) || data.version < 1 || data.bytes !== file.buffer.length ||
            typeof data.secure_url !== 'string' || !data.secure_url.startsWith(expectedPrefix)
        ) {
            throw new Error('INVALID_STORAGE_RESPONSE');
        }
        return data.secure_url;
    } catch {
        throw new ApiError(503, text.STORAGE_UNAVAILABLE);
    }
};

/** Delete a failed attempt asset; an already missing asset counts as successful cleanup. */
const deleteImage = async (storageKey) => {
    try {
        const params = signedStorageParams({
            public_id: storageKey,
            timestamp: Math.floor(Date.now() / 1000),
            type: 'authenticated',
        });
        const { data } = await axios.post(storageEndpoint('destroy'), new URLSearchParams(params), {
            timeout: AI_LIMITS.CLEANUP_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: AI_LIMITS.MAX_RESPONSE_BYTES,
        });
        if (!['ok', 'not found'].includes(data.result)) throw new Error('INVALID_STORAGE_RESPONSE');
    } catch {
        throw new ApiError(503, text.STORAGE_UNAVAILABLE);
    }
};

/** Grant temporary image access after the history authorization check has succeeded. */
const imageDownloadUrl = (storageKey, expiresAt) => {
    const params = signedStorageParams({
        public_id: storageKey,
        type: 'authenticated',
        timestamp: Math.floor(Date.now() / 1000),
        expires_at: expiresAt,
    });
    return `${storageEndpoint('download')}?${new URLSearchParams(params)}`;
};

// Internal classification contract -------------------------------------------

/** Share one timeout budget between metadata retrieval and classification. */
const remainingAiBudget = (startedAt) => {
    const remaining = config.ai.timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
        const error = new Error('AI_TIMEOUT');
        error.code = 'ECONNABORTED';
        throw error;
    }
    return remaining;
};

const label = Joi.string().valid(...AI_LABELS);
const responseSchema = Joi.object({
    predicted_label: label.required(),
    confidence: Joi.number().min(0).max(1).required(),
    predictions: Joi.array().length(AI_LABELS.length).unique('label').items(Joi.object({
        label: label.required(),
        probability: Joi.number().min(0).max(1).required(),
    })).required(),
    recommendation: Joi.string().max(500).required(),
    model_version: Joi.string().max(100).required(),
    processing_time_ms: Joi.number().integer().min(0).max(AI_LIMITS.MAX_PROCESSING_TIME_MS).required(),
});
const infoSchema = Joi.object({
    model_version: Joi.string().max(100).required(),
    checkpoint_sha256: Joi.string().hex().length(64).required(),
    class_order: Joi.array().length(AI_LABELS.length).unique().items(label).required(),
    output_kind: Joi.string().valid('probabilities').required(),
    preprocessing: Joi.object().required(),
    input_adapter: Joi.object().required(),
    quality_gate: Joi.object().required(),
    runtime: Joi.object().required(),
    release_status: Joi.string().required(),
    field_validated: Joi.boolean().required(),
}).unknown(true);

/** Validate model metadata and retain the runtime configuration needed to interpret this run. */
const modelSnapshot = (data) => {
    const { error, value } = infoSchema.validate(data, { convert: false });
    if (error) throw new Error('AI_INVALID_RESPONSE');
    return {
        modelVersion: value.model_version,
        checkpointSha256: value.checkpoint_sha256,
        classOrder: value.class_order,
        outputKind: value.output_kind,
        preprocessing: value.preprocessing,
        inputAdapter: value.input_adapter,
        qualityGate: value.quality_gate,
        runtime: value.runtime,
        releaseStatus: value.release_status,
        fieldValidated: value.field_validated,
    };
};

/** Accept only ordered, normalized probabilities from the same model described by its metadata. */
const classificationResult = (data, model) => {
    const { error, value } = responseSchema.validate(data, { convert: false });
    if (error) throw new Error('AI_INVALID_RESPONSE');
    // Ultralytics already returns probabilities; applying another softmax would change the result.
    const top = value.predictions[0];
    const total = value.predictions.reduce((sum, entry) => sum + entry.probability, 0);
    const unsorted = value.predictions.some((entry, index, all) =>
        index > 0 && entry.probability > all[index - 1].probability);
    if (
        Math.abs(total - 1) > AI_LIMITS.PROBABILITY_TOLERANCE || unsorted ||
        top.label !== value.predicted_label || top.probability !== value.confidence ||
        value.model_version !== model.modelVersion
    ) {
        throw new Error('AI_INVALID_RESPONSE');
    }
    return {
        runStatus: AI_RUN_STATUS.SUCCESS,
        predictedLabel: value.predicted_label,
        confidence: value.confidence,
        predictions: value.predictions,
        recommendation: value.recommendation,
        modelVersion: value.model_version,
        processingTimeMs: value.processing_time_ms,
    };
};

/** Map upstream failures to stable HTTP statuses and safe messages suitable for stored history. */
const classificationFailure = (error, model, startedAt) => {
    let errorCode = 'AI_UNAVAILABLE';
    let statusCode = 503;
    let message = text.UNAVAILABLE;
    if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
        errorCode = 'AI_TIMEOUT';
        statusCode = 504;
        message = text.TIMEOUT;
    } else if (error.response?.status === 422) {
        errorCode = 'AI_IMAGE_REJECTED';
        statusCode = 400;
        message = text.IMAGE_REJECTED;
    } else if (error.response?.status === 429) {
        errorCode = 'AI_RATE_LIMITED';
        statusCode = 429;
        message = text.RATE_LIMITED;
    } else if (error.message === 'AI_INVALID_RESPONSE') {
        errorCode = 'AI_INVALID_RESPONSE';
        statusCode = 502;
        message = text.INVALID_RESPONSE;
    }
    return {
        model,
        statusCode,
        result: {
            runStatus: AI_RUN_STATUS.ERROR,
            predictions: [],
            modelVersion: model?.modelVersion ?? null,
            processingTimeMs: Math.min(Math.max(0, Date.now() - startedAt), AI_LIMITS.MAX_PROCESSING_TIME_MS),
            errorCode,
            errorMessage: message,
        },
    };
};

/** Send original bytes to the classifier and return a validated success or a persistable safe error. */
const classifyImages = async (files, requestId) => {
    const started = Date.now();
    let model = null;
    try {
        if (!config.ai.serviceUrl || !config.ai.apiKey) throw new Error('AI_NOT_CONFIGURED');
        const options = {
            headers: { 'X-API-Key': config.ai.apiKey, 'X-Request-Id': requestId },
            timeout: remainingAiBudget(started),
            maxRedirects: 0,
            maxContentLength: AI_LIMITS.MAX_RESPONSE_BYTES,
            maxBodyLength: AI_LIMITS.MAX_IMAGES * AI_LIMITS.MAX_FILE_BYTES + AI_LIMITS.MULTIPART_OVERHEAD_BYTES,
        };
        const info = await axios.get(`${config.ai.serviceUrl}/v1/model/info`, options);
        model = modelSnapshot(info.data);
        const form = new FormData();
        files.forEach((file, index) => form.append('images',
            new Blob([file.buffer], { type: file.mimetype }), `image-${index}`));
        const { data } = await axios.post(`${config.ai.serviceUrl}/v1/diagnose`, form, {
            ...options,
            timeout: remainingAiBudget(started),
        });
        return { model, result: classificationResult(data, model) };
    } catch (error) {
        return classificationFailure(error, model, started);
    }
};

// History response mapping ---------------------------------------------------

/** Expand disease abbreviations in advice, including recommendations stored by older runs. */
const recommendationText = (value) => value
    .replace(/\s*\((?:WSSV|BG|WSSV_BG|WSSV\/BG)\)/gi, '')
    .replace(/\bWSSV(?:_BG|\/BG)\b/gi, 'đốm trắng và mang đen')
    .replace(/\bWSSV\b/gi, 'đốm trắng')
    .replace(/\bBG\b/gi, 'mang đen');

const summarySelect = {
    id: true, createdAt: true, runStatus: true, predictedLabel: true, predictions: true, imageUrls: true,
};

/** Return a compact list item; failed runs have no prediction fields. */
const summary = (row) => ({
    id: row.id,
    createdAt: row.createdAt,
    runStatus: row.runStatus,
    imageCount: row.imageUrls.length,
    ...(row.runStatus === AI_RUN_STATUS.SUCCESS && recognitionResult(row)),
});

/** Return an owned result with temporary image access and compatibility for legacy snapshots. */
const detail = (row) => {
    const recognition = row.runStatus === AI_RUN_STATUS.SUCCESS ? recognitionResult(row) : null;
    const expiresAt = Math.floor(Date.now() / 1000) + AI_LIMITS.IMAGE_URL_TTL_SECONDS;
    const assets = row.inputSnapshot?.images;
    const hasStoredAssets = Array.isArray(assets) && assets.length === row.imageUrls.length &&
        assets.every((image, index) => image && AI_IMAGE_TYPES[image.mimeType] &&
            image.storageKey === imageKey(row.id, index, { mimetype: image.mimeType }));
    return {
        id: row.id,
        seasonId: row.seasonId,
        createdAt: row.createdAt,
        runStatus: row.runStatus,
        imageUrls: hasStoredAssets ? assets.map((image) => imageDownloadUrl(image.storageKey, expiresAt)) : row.imageUrls,
        ...(hasStoredAssets && { imageUrlsExpireAt: new Date(expiresAt * 1000) }),
        modelVersion: row.modelVersion,
        processingTimeMs: row.processingTimeMs,
        ...(recognition ? {
            ...recognition,
            predictions: row.predictions.map((prediction) => ({
                ...prediction, label: AI_LABEL_NAMES[prediction.label],
            })),
            recommendation: recognition.recognitionStatus === AI_RECOGNITION_STATUS.RECOGNIZED
                ? recommendationText(row.recommendation) : text.LOW_CONFIDENCE,
        } : { error: { code: row.errorCode, message: row.errorMessage } }),
    };
};

// Persistence and failed-attempt cleanup --------------------------------------

/** Attempt every cleanup without replacing the original request error with a storage failure. */
const cleanupImages = async (keys) => {
    const results = await Promise.allSettled(keys.map((key) => deleteImage(key)));
    results.forEach((result, index) => {
        if (result.status === 'rejected') logger.error('AI image cleanup failed', { storageKey: keys[index] });
    });
};

/** Lock mutable access rows, recheck permissions and insert the final outcome in a short transaction. */
const saveResult = async (accountId, seasonId, data) => {
    try {
        return await prisma.$transaction(async (db) => {
            // Prisma has no row-lock API. These shared locks prevent account, season and
            // assignment changes between the final permission check and log insertion.
            await db.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR SHARE`;
            await db.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR SHARE`;
            await db.$queryRaw`SELECT id FROM season_personnel_assignments
                WHERE season_id = ${seasonId}::uuid AND account_id = ${accountId}::uuid
                AND role = 'technician' AND unassigned_at IS NULL FOR SHARE`;
            await requireScope(db, accountId, seasonId, true);
            return db.aiDiagnosisLog.create({ data });
        });
    } catch (error) {
        if (error.code === 'P2034') throw ApiError.conflict(text.CONFLICT);
        throw error;
    }
};

// Public diagnosis operations ------------------------------------------------

/** Upload originals, classify them and commit either SUCCESS or ERROR before responding. */
const createDiagnosis = async (accountId, seasonId, files) => {
    await assertCanCreateDiagnosis(accountId, seasonId);
    storageSettings();
    const id = randomUUID();
    const images = files.map((file, index) => ({
        storageKey: imageKey(id, index, file),
        mimeType: file.mimetype,
        size: file.size,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
    }));
    const attemptedKeys = [];
    let saved;
    let outcome;
    try {
        const imageUrls = [];
        // Upload sequentially to avoid other batch uploads still running when one fails.
        for (const [index, file] of files.entries()) {
            // A timed-out upload may still create an asset, so register its key before awaiting it.
            attemptedKeys.push(images[index].storageKey);
            imageUrls.push(await uploadImage(images[index].storageKey, file));
        }
        outcome = await classifyImages(files, id);
        saved = await saveResult(accountId, seasonId, {
            id,
            seasonId,
            requestedBy: accountId,
            imageUrls,
            ...outcome.result,
            inputSnapshot: { requestId: id, images, model: outcome.model },
        });
    } catch (error) {
        // A failed commit acknowledgement may still have persisted the row. Never
        // delete its images until the database confirms there is no reference.
        let canDelete = false;
        try {
            canDelete = !await prisma.aiDiagnosisLog.findUnique({ where: { id }, select: { id: true } });
        } catch {
            logger.error('AI image cleanup deferred: log persistence could not be checked', { diagnosisId: id });
        }
        if (canDelete) await cleanupImages(attemptedKeys);
        throw error;
    }
    // Persist technical failures before raising the HTTP error so history remains available.
    if (outcome.result.runStatus === AI_RUN_STATUS.ERROR) {
        const error = new ApiError(outcome.statusCode, outcome.result.errorMessage);
        error.errorCode = outcome.result.errorCode;
        throw error;
    }
    return detail(saved);
};

const cursorSchema = Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() });

/** Validate an untrusted cursor before resolving it inside the caller's history scope. */
const decodeCursor = (cursor) => {
    try {
        const { error, value } = cursorSchema.validate(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
        if (error) throw error;
        return value;
    } catch {
        throw ApiError.badRequest(text.INVALID_CURSOR);
    }
};

/** Read owned history and its total count from one snapshot with a stable database cursor. */
const listDiagnoses = async (accountId, seasonId, { limit = AI_LIMITS.DEFAULT_PAGE_SIZE, cursor, runStatus } = {}) => {
    await requireScope(prisma, accountId, seasonId);
    const where = { ...scopeWhere(accountId, seasonId), ...(runStatus && { runStatus }) };
    return prisma.$transaction(async (db) => {
        let pagination = {};
        if (cursor) {
            const decoded = decodeCursor(cursor);
            const ownedCursor = await db.aiDiagnosisLog.findFirst({
                where: { ...where, ...decoded },
                select: { id: true },
            });
            if (!ownedCursor) throw ApiError.badRequest(text.INVALID_CURSOR);
            // Let PostgreSQL resolve the cursor timestamp: JS Date drops microseconds.
            pagination = { cursor: { id: decoded.id }, skip: 1 };
        }
        const rows = await db.aiDiagnosisLog.findMany({
            where,
            ...pagination,
            select: summarySelect,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
        });
        const totalResults = await db.aiDiagnosisLog.count({ where });
        const hasNextPage = rows.length > limit;
        const items = rows.slice(0, limit);
        const last = items[items.length - 1];
        const nextCursor = hasNextPage ? Buffer.from(JSON.stringify({ id: last.id })).toString('base64url') : null;
        return {
            diagnoses: items.map(summary),
            meta: { totalResults, hasNextPage, nextCursor },
        };
    }, { isolationLevel: 'RepeatableRead' });
};

/** Read one owned result without exposing internal snapshots or another technician's history. */
const getDiagnosis = async (accountId, seasonId, id) => {
    await requireScope(prisma, accountId, seasonId);
    const row = await prisma.aiDiagnosisLog.findFirst({ where: { id, ...scopeWhere(accountId, seasonId) } });
    if (!row) throw ApiError.notFound(text.NOT_FOUND);
    return detail(row);
};

module.exports = { assertCanCreateDiagnosis, createDiagnosis, listDiagnoses, getDiagnosis };
