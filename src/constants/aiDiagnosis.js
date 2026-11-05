const AI_RUN_STATUS = Object.freeze({ SUCCESS: 'SUCCESS', ERROR: 'ERROR' });
const AI_LABELS = Object.freeze(['Healthy', 'BG', 'WSSV', 'WSSV_BG']);
const AI_LABEL_NAMES = Object.freeze({
    Healthy: 'Khỏe mạnh',
    BG: 'Mang đen',
    WSSV: 'Đốm trắng',
    WSSV_BG: 'Đốm trắng và mang đen',
});
const AI_LIMITS = Object.freeze({
    MAX_IMAGES: 5,
    MAX_FILE_BYTES: 10 * 1024 * 1024,
    MAX_CONCURRENT_UPLOADS: 2,
    IMAGE_URL_TTL_SECONDS: 300,
    MAX_RESPONSE_BYTES: 64 * 1024,
    MULTIPART_OVERHEAD_BYTES: 64 * 1024,
    MAX_PROCESSING_TIME_MS: 2147483647,
    STORAGE_TIMEOUT_MS: 30000,
    CLEANUP_TIMEOUT_MS: 10000,
    PROBABILITY_TOLERANCE: 1e-6,
    DEFAULT_PAGE_SIZE: 20,
    MAX_PAGE_SIZE: 50,
    REQUESTS_PER_MINUTE: 5,
});
const AI_IMAGE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

module.exports = { AI_RUN_STATUS, AI_LABELS, AI_LABEL_NAMES, AI_LIMITS, AI_IMAGE_TYPES };
