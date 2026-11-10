const { createHash } = require('crypto');
const axios = require('axios');
const Joi = require('joi');
const prisma = require('../config/prisma');
const config = require('../config');
const { ApiError, checkIngredients } = require('../utils');
const {
    PRODUCT_REGULATORY_TYPE,
    INVENTORY_LABEL_PROMPT,
    INVENTORY_LABEL_LIMITS: limits,
    messages,
    httpStatus,
} = require('../constants');

const fieldTypes = {
    name: { type: ['string', 'null'], maxLength: 255 },
    manufacturerName: { type: ['string', 'null'], maxLength: 255 },
    regulatoryType: { type: ['string', 'null'], enum: [...Object.values(PRODUCT_REGULATORY_TYPE), null] },
    registrationNumber: { type: ['string', 'null'], maxLength: 100 },
    ingredientsText: { type: ['string', 'null'], maxLength: 12000 },
    usageInstructions: { type: ['string', 'null'], maxLength: 12000 },
    containsAntibiotic: { type: ['boolean', 'null'] },
    withdrawalDays: { type: ['number', 'null'], minimum: 0, maximum: 9999.999 },
};
const responseSchema = {
    type: 'object',
    properties: {
        fields: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(fieldTypes).map(([name, type]) => [name, {
                type: 'object',
                properties: { value: type, evidence: { type: ['string', 'null'], maxLength: 12000 } },
                required: ['value', 'evidence'],
                additionalProperties: false,
            }])),
            required: Object.keys(fieldTypes),
            additionalProperties: false,
        },
        warnings: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 10 },
    },
    required: ['fields', 'warnings'],
    additionalProperties: false,
};
const valueSchemas = {
    name: Joi.string().trim().max(255),
    manufacturerName: Joi.string().trim().max(255),
    regulatoryType: Joi.string().valid(...Object.values(PRODUCT_REGULATORY_TYPE)),
    registrationNumber: Joi.string().trim().max(100),
    ingredientsText: Joi.string().trim().max(12000),
    usageInstructions: Joi.string().trim().max(12000),
    containsAntibiotic: Joi.boolean(),
    withdrawalDays: Joi.number().min(0).max(9999.999).precision(3),
};
const resultValidator = Joi.object({
    fields: Joi.object(Object.fromEntries(Object.entries(valueSchemas).map(([name, schema]) => [name, Joi.object({
        value: schema.allow(null).required(),
        evidence: Joi.string().trim().max(12000).allow('', null).required(),
    }).required()]))).required(),
    warnings: Joi.array().items(Joi.string().trim().max(500)).max(10).required(),
}).prefs({ convert: false });

// Cache, quota and concurrency are per process and reset on restart; see docs/INVENTORY_LABEL_OCR.md.
const cache = new Map();
const pending = new Map();
let activeRequests = 0;
let quotaDay = '';
let dailyCalls = 0;
let cooldownUntil = 0;

const imageMimeType = (bytes) => {
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    throw ApiError.badRequest(messages.INVENTORY_LABEL.INVALID_IMAGE_TYPE);
};

const loadImage = async (image) => {
    let bytes;
    if (image.data) {
        bytes = Buffer.from(image.data, 'base64');
    } else {
        const url = new URL(image.url);
        const cloudName = config.ocr.imageCloudName;
        // Fixed host/path and no redirects prevent arbitrary URL fetching through OCR.
        if (!cloudName || url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com'
            || url.port || url.username || url.password || url.search || url.hash
            || !url.pathname.startsWith(`/${cloudName}/image/upload/`)) {
            throw ApiError.badRequest(messages.INVENTORY_LABEL.INVALID_IMAGE_SOURCE);
        }
        try {
            const response = await axios.get(url.href, {
                responseType: 'arraybuffer', timeout: limits.IMAGE_DOWNLOAD_TIMEOUT_MS, maxRedirects: 0,
                maxContentLength: limits.MAX_IMAGE_BYTES, proxy: false,
            });
            bytes = Buffer.from(response.data);
        } catch {
            throw ApiError.badRequest(messages.INVENTORY_LABEL.IMAGE_DOWNLOAD_FAILED);
        }
    }
    if (!bytes.length || bytes.length > limits.MAX_IMAGE_BYTES) {
        throw ApiError.badRequest(messages.INVENTORY_LABEL.INVALID_IMAGE_SIZE);
    }
    return { inlineData: { mimeType: imageMimeType(bytes), data: bytes.toString('base64') }, size: bytes.length };
};

const parseResult = (body) => {
    const candidate = body?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') {
        throw new ApiError(httpStatus.BAD_GATEWAY, messages.INVENTORY_LABEL.INCOMPLETE_RESULT);
    }
    let parsed;
    try {
        const text = candidate.content.parts
            .filter((part) => !part.thought && typeof part.text === 'string')
            .map((part) => part.text)
            .join('');
        parsed = JSON.parse(text);
    } catch {
        throw new ApiError(httpStatus.BAD_GATEWAY, messages.INVENTORY_LABEL.INVALID_RESULT);
    }
    const { error, value } = resultValidator.validate(parsed);
    if (error) throw new ApiError(httpStatus.BAD_GATEWAY, messages.INVENTORY_LABEL.INVALID_RESULT);
    const result = { evidence: {}, warnings: [...value.warnings] };
    for (const [name, field] of Object.entries(value.fields)) {
        const evidence = field.evidence?.trim();
        result[name] = evidence ? field.value : null;
        if (result[name] !== null) result.evidence[name] = evidence;
    }
    if (Object.keys(result.evidence).length === 0) {
        result.warnings.push(messages.INVENTORY_LABEL.NO_EVIDENCE);
    }
    return { ...result, substanceCheck: checkIngredients(result.ingredientsText) };
};

const requestGemini = async (images) => {
    const loaded = await Promise.all(images.map(loadImage));
    if (loaded.reduce((sum, image) => sum + image.size, 0) > limits.MAX_TOTAL_BYTES) {
        throw ApiError.badRequest(messages.INVENTORY_LABEL.TOTAL_SIZE_EXCEEDED);
    }
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (quotaDay !== today) {
        quotaDay = today;
        dailyCalls = 0;
    }
    if (dailyCalls >= config.ocr.dailyLimit) {
        throw new ApiError(httpStatus.TOO_MANY_REQUESTS, messages.INVENTORY_LABEL.DAILY_LIMIT);
    }
    dailyCalls += 1;
    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.ocr.model)}:generateContent`,
            {
                systemInstruction: { parts: [{ text: INVENTORY_LABEL_PROMPT }] },
                contents: [{ role: 'user', parts: loaded.map(({ inlineData }) => ({ inlineData })) }],
                generationConfig: {
                    maxOutputTokens: limits.MAX_OUTPUT_TOKENS,
                    responseMimeType: 'application/json', responseJsonSchema: responseSchema,
                },
            },
            {
                headers: { 'x-goog-api-key': config.ocr.apiKey }, timeout: config.ocr.timeoutMs,
                maxContentLength: limits.MAX_RESPONSE_BYTES,
                maxBodyLength: limits.MAX_REQUEST_BYTES,
                maxRedirects: 0, proxy: false,
            },
        );
        return parseResult(response.data);
    } catch (error) {
        if (error instanceof ApiError) throw error;
        // Never propagate Axios errors: they contain the provider key and image payload.
        const status = error.response?.status;
        if (status === httpStatus.TOO_MANY_REQUESTS) {
            cooldownUntil = Date.now() + limits.PROVIDER_COOLDOWN_MS;
            throw new ApiError(httpStatus.TOO_MANY_REQUESTS, messages.INVENTORY_LABEL.PROVIDER_QUOTA);
        }
        if ([httpStatus.BAD_REQUEST, httpStatus.UNAUTHORIZED, httpStatus.FORBIDDEN, httpStatus.NOT_FOUND].includes(status)) {
            throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.INVENTORY_LABEL.INVALID_CONFIG);
        }
        if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
            throw new ApiError(httpStatus.GATEWAY_TIMEOUT, messages.INVENTORY_LABEL.TIMEOUT);
        }
        throw new ApiError(httpStatus.BAD_GATEWAY, messages.INVENTORY_LABEL.PROVIDER_UNAVAILABLE);
    }
};

const scanLabel = async (farmId, ownerId, images) => {
    const farm = await prisma.farm.findFirst({ where: { id: farmId, ownerId }, select: { id: true } });
    if (!farm) throw ApiError.notFound(messages.INVENTORY.FARM_NOT_FOUND);
    if (!config.ocr.apiKey) {
        throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.INVENTORY_LABEL.MISSING_KEY);
    }
    const key = createHash('sha256')
        .update(JSON.stringify([ownerId, farmId, config.ocr.model, config.ocr.apiKey, images]))
        .digest('hex');
    const now = Date.now();
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    const cached = cache.get(key);
    if (cached) return structuredClone(cached.result);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    if (now < cooldownUntil) {
        throw new ApiError(httpStatus.TOO_MANY_REQUESTS, messages.INVENTORY_LABEL.COOLDOWN);
    }
    if (activeRequests >= limits.MAX_CONCURRENT_REQUESTS) {
        throw new ApiError(httpStatus.TOO_MANY_REQUESTS, messages.INVENTORY_LABEL.BUSY);
    }
    activeRequests += 1;
    const task = requestGemini(images);
    pending.set(key, task);
    try {
        const result = await task;
        if (cache.size >= limits.CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(key, { result, expires: Date.now() + limits.CACHE_TTL_MS });
        return structuredClone(result);
    } finally {
        activeRequests -= 1;
        pending.delete(key);
    }
};

module.exports = { scanLabel };
