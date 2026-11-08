const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { ApiError, asyncHandler } = require('../utils');
const { AI_LIMITS, AI_IMAGE_TYPES, messages } = require('../constants');
const aiDiagnosisService = require('../services/aiDiagnosis.service');
const text = messages.AI_DIAGNOSIS;

/** Reject mismatched MIME/signature pairs before storage; AI still performs full image decoding. */
const matchesImageType = ({ buffer, mimetype }) => {
    if (mimetype === 'image/png')
        return buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (mimetype === 'image/jpeg')
        return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    return (
        mimetype === 'image/webp' &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    );
};

/** Reject unsupported MIME declarations before Multer buffers their file streams. */
const filterImage = (req, file, done) => {
    done(AI_IMAGE_TYPES[file.mimetype] ? null : ApiError.badRequest(text.INVALID_IMAGES), true);
};

// Parser limits apply before controller execution and bound each request to five 10 MiB files.
const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: AI_LIMITS.MAX_IMAGES,
        fileSize: AI_LIMITS.MAX_FILE_BYTES,
        fields: 0,
        parts: AI_LIMITS.MAX_IMAGES,
        fieldNameSize: 32,
        fieldNestingDepth: 0,
        fieldArrayIndexLimit: 0,
    },
    fileFilter: filterImage,
}).array('images', AI_LIMITS.MAX_IMAGES);

/** Accept only image multipart bodies and convert parser failures to the shared API error flow. */
const uploadImages = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next(ApiError.badRequest(text.INVALID_MULTIPART));
    return parser(req, res, (error) => {
        if (error)
            return next(
                error instanceof ApiError ? error : ApiError.badRequest(text.INVALID_IMAGES),
            );
        if (!req.files?.length || req.files.some((file) => !file.size || !matchesImageType(file))) {
            return next(ApiError.badRequest(text.INVALID_IMAGES));
        }
        return next();
    });
};

/** Call the domain service before buffering files; authorization is repeated at persistence time. */
const authorizeDiagnosisUpload = asyncHandler(async (req, res, next) => {
    await aiDiagnosisService.assertCanCreateDiagnosis(req.account.id, req.params.seasonId);
    next();
});

let activeRequests = 0;
/** Bound concurrent buffered requests; disconnected clients must not free capacity during active work. */
const admitUpload = (req, res, next) => {
    if (activeRequests >= AI_LIMITS.MAX_CONCURRENT_UPLOADS)
        return next(new ApiError(503, text.BUSY));
    activeRequests += 1;
    let released = false;
    /** Release exactly once, whether completion comes from a response event or the handler's finally block. */
    res.locals.releaseAiUpload = () => {
        if (released) return;
        released = true;
        activeRequests -= 1;
        req.files = undefined;
    };
    res.once('finish', res.locals.releaseAiUpload);
    res.once('close', () => {
        if (!res.locals.aiWorkStarted) res.locals.releaseAiUpload();
    });
    next();
};

/** Hold an admitted slot until the controller settles, even after the client closes its socket. */
const completeUpload = (handler) =>
    asyncHandler(async (req, res) => {
        res.locals.aiWorkStarted = true;
        try {
            await handler(req, res);
        } finally {
            res.locals.releaseAiUpload();
        }
    });

// Quota is per authenticated technician and per BE process; it is not a distributed rate limit.
const diagnosisLimiter = rateLimit({
    windowMs: 60000,
    limit: AI_LIMITS.REQUESTS_PER_MINUTE,
    keyGenerator: (req) => req.account.id,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => next(new ApiError(429, text.RATE_LIMITED)),
});

/** Prevent caches from retaining private history or temporary image links. */
const noStore = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
};

module.exports = {
    uploadImages,
    authorizeDiagnosisUpload,
    admitUpload,
    completeUpload,
    diagnosisLimiter,
    noStore,
};
