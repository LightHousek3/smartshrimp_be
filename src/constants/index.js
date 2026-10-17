/**
 * Shared domain enums, response messages, and validation policies exposed through the constants barrel.
 * Keep persisted enum values aligned with the database and API consumers.
 */
const httpStatus = require('./httpStatus');
const messages = require('./messages');
const NOTIFICATION_TYPE = require('./notificationType');

// Keep harvest response and error messages consistent across the controller and service.
const HARVEST_MESSAGES = {
    NOT_FOUND: 'Không tìm thấy lần thu hoạch hoặc vụ nuôi.',
    CONFLICT: 'Dữ liệu thu hoạch đã thay đổi. Vui lòng tải lại và thử lại.',
    INACTIVE: 'Chỉ ghi nhận thu hoạch cho vụ nuôi đang hoạt động.',
    INVALID_QUANTITY: 'Sản lượng hoặc số lượng thu hoạch không hợp lệ.',
    INVALID_TIME: 'Thời điểm thu hoạch phải từ ngày thả giống, không trước lần thu gần nhất và không ở tương lai.',
    INVALID_CURSOR: 'Con trỏ phân trang không hợp lệ.',
    KEY_CONFLICT: 'Khóa ghi nhận đã được sử dụng cho dữ liệu khác.',
    LIST: 'Đã tải danh sách thu hoạch.',
    DETAIL: 'Đã tải chi tiết thu hoạch.',
    CREATED: 'Đã ghi nhận thu hoạch.',
};

const DASHBOARD_PERIOD = Object.freeze({
    THIS_MONTH: 'THIS_MONTH',
    LAST_MONTH: 'LAST_MONTH',
    SIX_MONTHS: 'SIX_MONTHS',
    YEAR: 'YEAR',
    CUSTOM: 'CUSTOM',
});

const ALERT_KIND = Object.freeze({
    URGENT_TASK: 'URGENT_TASK',
    PENDING_TREATMENT: 'PENDING_TREATMENT',
    PENDING_PRODUCTION: 'PENDING_PRODUCTION',
    LOW_STOCK: 'LOW_STOCK',
    IN_TREATMENT: 'IN_TREATMENT',
    MONITORING: 'MONITORING',
});

/**
 * Enums matching the database schema
 */
const ACCOUNT_ROLE = {
    ADMIN: 'ADMIN',
    FARM_OWNER: 'FARM_OWNER',
    TECHNICIAN: 'TECHNICIAN',
    EXPERT: 'EXPERT',
};

const ACCOUNT_STATUS = {
    PENDING_ACTIVATION: 'PENDING_ACTIVATION',
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    BLOCKED: 'BLOCKED',
};

const VERIFICATION_PURPOSE = {
    ACCOUNT_ACTIVATION: 'ACCOUNT_ACTIVATION',
    PASSWORD_RESET: 'PASSWORD_RESET',
};

const SHRIMP_TYPE = {
    WHITELEG: 'WHITELEG',
    BLACK_TIGER: 'BLACK_TIGER',
};

const SEASON_STATUS = {
    PLANNING: 'PLANNING',
    ACTIVE: 'ACTIVE',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
};

const PERSONNEL_ROLE = {
    TECHNICIAN: 'TECHNICIAN',
    EXPERT: 'EXPERT',
};

const OPERATION_TYPE = {
    FEEDING: 'FEEDING',
    MINERAL: 'MINERAL',
    CHEMICAL: 'CHEMICAL',
    MEDICINE: 'MEDICINE',
    OTHER: 'OTHER',
};

const OPERATION_STATUS = {
    PLANNED: 'PLANNED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
};

const PRODUCT_CATEGORY = Object.freeze({
    FEED: 'FEED',
    MEDICINE: 'MEDICINE',
    MINERAL: 'MINERAL',
    CHEMICAL: 'CHEMICAL',
    OTHER: 'OTHER',
});

const PRODUCT_UNIT = Object.freeze({
    KG: 'KG',
    G: 'G',
    L: 'L',
    ML: 'ML',
    PACK: 'PACK',
    BOTTLE: 'BOTTLE',
    PCS: 'PCS',
});

const CONVERSION_UNIT = Object.freeze({
    MG: 'MG',
    G: 'G',
    KG: 'KG',
    ML: 'ML',
    L: 'L',
});

const INVENTORY_TRANSACTION_TYPE = Object.freeze({
    STOCK_IN: 'STOCK_IN',
    ADJUSTMENT_IN: 'ADJUSTMENT_IN',
    ADJUSTMENT_OUT: 'ADJUSTMENT_OUT',
    STOCK_OUT: 'STOCK_OUT',
});

const OWNER_INVENTORY_TRANSACTION_TYPES = Object.freeze([
    INVENTORY_TRANSACTION_TYPE.STOCK_OUT,
    INVENTORY_TRANSACTION_TYPE.STOCK_IN,
    INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_IN,
    INVENTORY_TRANSACTION_TYPE.ADJUSTMENT_OUT,
]);

const PRODUCT_STOCK_STATUS = Object.freeze({
    ALL: 'ALL',
    LOW: 'LOW',
});

const PRODUCT_ARCHIVE_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    ARCHIVED: 'ARCHIVED',
    ALL: 'ALL',
});

const INVENTORY_LIMITS = Object.freeze({
    MAX_BALANCE_QUANTITY: '99999999999.999',
    MAX_TRANSACTION_AMOUNT: '9999999999999999.99',
});

const DOSE_BASIS = {
    FIXED_QUANTITY: 'FIXED_QUANTITY',
    PER_KG_BIOMASS: 'PER_KG_BIOMASS',
    PERCENT_BIOMASS: 'PERCENT_BIOMASS',
    PER_M3_WATER: 'PER_M3_WATER',
};

const PRODUCTION_PROTOCOL_EDITABLE_STATUSES = ['DRAFT', 'REJECTED'];
const PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES = [
    ...PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    'PENDING_APPROVAL',
];
const PRODUCTION_PROTOCOL_WRITABLE_SEASONS = [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE];
const PRODUCTION_PROTOCOL_UNITS = ['KG', 'G', 'L', 'ML', 'PACK', 'BOTTLE', 'PCS'];
const PRODUCTION_PROTOCOL_CATEGORIES = ['FEED', 'MEDICINE', 'MINERAL', 'CHEMICAL', 'OTHER'];

// Biomass-based dosing becomes available from day 30; earlier days use restricted bases.
const allowedProductionProtocolDoseBases = (operationType, offset) => {
    if (offset >= 30) {
        return Object.values(DOSE_BASIS);
    }

    if ([OPERATION_TYPE.FEEDING, OPERATION_TYPE.MEDICINE].includes(operationType)) {
        return [DOSE_BASIS.FIXED_QUANTITY];
    }

    return [DOSE_BASIS.FIXED_QUANTITY, DOSE_BASIS.PER_M3_WATER];
};

const SCHEDULE_CANCELLATION_TYPE = {
    PROTOCOL_SUPERSEDED: 'PROTOCOL_SUPERSEDED',
    TREATMENT_ABORTED: 'TREATMENT_ABORTED',
    SEASON_CANCELLED: 'SEASON_CANCELLED',
    MANUAL_CORRECTION: 'MANUAL_CORRECTION',
};

// RAG query status and document upload rules
const RAG_STATUS = { ANSWERED: 'ANSWERED', NO_SOURCE: 'NO_SOURCE', LOW_MATCH: 'LOW_MATCH', ERROR: 'ERROR' };
const RAG_DOCUMENT_STATUS = Object.freeze({
    UPLOADING: 'UPLOADING',
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    READY: 'READY',
    FAILED: 'FAILED',
    DELETING: 'DELETING',
    DELETE_FAILED: 'DELETE_FAILED',
});
const RAG_DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const RAG_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.md', '.txt'];
const RAG_DOCUMENT_CATEGORIES = Object.freeze(['Kỹ thuật nuôi', 'Bệnh trên tôm', 'Khác']);
// Cloudinary accepts upload signatures for one hour; allow an extra ten minutes for in-flight uploads.
const RAG_UPLOAD_SIGNATURE_TTL_MS = 60 * 60 * 1000;
const RAG_UPLOAD_CLEANUP_DELAY_MS = RAG_UPLOAD_SIGNATURE_TTL_MS + 10 * 60 * 1000;

const RAG_DOCUMENT_ERRORS = Object.freeze({
    RAG_SOURCE_MISSING: { status: httpStatus.NOT_FOUND, message: messages.RAG_DOCUMENT_ERRORS.RAG_SOURCE_MISSING },
    RAG_STORAGE_AUTH: { status: httpStatus.SERVICE_UNAVAILABLE, message: messages.RAG_DOCUMENT_ERRORS.RAG_STORAGE_AUTH },
    RAG_STORAGE_TIMEOUT: { status: httpStatus.GATEWAY_TIMEOUT, message: messages.RAG_DOCUMENT_ERRORS.RAG_STORAGE_TIMEOUT },
    RAG_STORAGE_UNAVAILABLE: { status: httpStatus.SERVICE_UNAVAILABLE, message: messages.RAG_DOCUMENT_ERRORS.RAG_STORAGE_UNAVAILABLE },
    RAG_INVALID_CONTENT: { status: httpStatus.BAD_REQUEST, message: messages.RAG_DOCUMENT_ERRORS.RAG_INVALID_CONTENT },
    RAG_INGESTION_TIMEOUT: { status: httpStatus.GATEWAY_TIMEOUT, message: messages.RAG_DOCUMENT_ERRORS.RAG_INGESTION_TIMEOUT },
    RAG_INGESTION_FAILED: { status: httpStatus.SERVICE_UNAVAILABLE, message: messages.RAG_DOCUMENT_ERRORS.RAG_INGESTION_FAILED },
    RAG_REUPLOAD_FILE_MISMATCH: { status: httpStatus.BAD_REQUEST, message: messages.RAG_DOCUMENT_ERRORS.RAG_REUPLOAD_FILE_MISMATCH },
});

/**
 * Water quality thresholds
 * ==========================
 * Species-specific warning thresholds used by:
 *  - F1 "Record water measurements": compare entered metrics and notify the farm
 *    owner with `water_threshold_exceeded` when limits are exceeded (BR-NOTI-03).
 *  - F4 "View water quality statistics": calculate the percentage of samples outside limits.
 *
 * DATA SOURCE (DRAFT 2026-10-08): compiled from online references
 * for whiteleg shrimp (L. vannamei) and black tiger shrimp (P. monodon).
 * The aquaculture team must review and adjust these draft values before production use.
 *
 * A value exceeds a threshold when it is outside the inclusive [min, max] range.
 * One-sided limits use null for the unbounded side, such as NH3 with only a maximum.
 * These operational warning thresholds differ from physical database CHECK ranges
 * (temperature 0–50, pH 0–14, other metrics >= 0); database constraints remain the final guard.
 *
 * NH3 caveat: `nh3_mg_l` does not yet distinguish free NH3 from TAN
 * (total ammonia nitrogen). These limits apply to the entered measurement;
 * the team must clarify the column definition, ideally deriving free NH3 from TAN, pH, and temperature.
 */

// Use the exact SHRIMP_TYPE keys: WHITELEG and BLACK_TIGER.
const WATER_THRESHOLDS = {
    WHITELEG: {
        // Whiteleg shrimp (Litopenaeus vannamei).
        // Reference summary: optimal temperature 25–33 (best 28–30);
        // pH 7.5–8.5; DO > 4 (optimal >= 5); salinity 15–25 (tolerated 5–35);
        // NH3 < 0.1; NO2 < 0.5; alkalinity > 120; H2S < 0.05.
        temperatureC:       { min: 25,  max: 33,  unit: '°C' },
        ph:                 { min: 7.5, max: 8.5, unit: 'pH' },
        dissolvedOxygenMgL: { min: 4.0, max: null, unit: 'mg/L' },
        salinityPpt:        { min: 10,  max: 30,  unit: 'ppt' },
        nh3MgL:             { min: null, max: 0.1, unit: 'mg/L' },
        no2MgL:             { min: null, max: 0.5, unit: 'mg/L' },
        alkalinityMgLCaCO3: { min: 100, max: 250, unit: 'mg/L CaCO3' },
        h2sMgL:             { min: null, max: 0.05, unit: 'mg/L' },
    },
    BLACK_TIGER: {
        // Black tiger shrimp (Penaeus monodon).
        // Reference summary: optimal temperature 26–32 (best 26–29);
        // pH 7.5–8.5; minimum DO 4; salinity 10–25 (tolerated 5–32);
        // maximum NH3-N 0.1; maximum NO2-N 0.5–1.0 (using the stricter 0.5);
        // H2S < 0.05; alkalinity 100–200.
        temperatureC:       { min: 26,  max: 32,  unit: '°C' },
        ph:                 { min: 7.5, max: 8.5, unit: 'pH' },
        dissolvedOxygenMgL: { min: 4.0, max: null, unit: 'mg/L' },
        salinityPpt:        { min: 10,  max: 30,  unit: 'ppt' },
        nh3MgL:             { min: null, max: 0.1, unit: 'mg/L' },
        no2MgL:             { min: null, max: 0.5, unit: 'mg/L' },
        alkalinityMgLCaCO3: { min: 100, max: 250, unit: 'mg/L CaCO3' },
        h2sMgL:             { min: null, max: 0.05, unit: 'mg/L' },
    },
};

// Map backend camelCase fields to threshold keys for the comparison loop.
// Add or remove compared metrics in this map and WATER_THRESHOLDS together.
const THRESHOLD_FIELD_MAP = {
    temperatureC: 'temperatureC',
    ph: 'ph',
    dissolvedOxygenMgL: 'dissolvedOxygenMgL',
    salinityPpt: 'salinityPpt',
    nh3MgL: 'nh3MgL',
    no2MgL: 'no2MgL',
    alkalinityMgLCaCO3: 'alkalinityMgLCaCO3',
    h2sMgL: 'h2sMgL',
};

const WATER_METRICS_POLICY_VERSION = 'water-v1';
const WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS = 300;
const WATER_NOTE_MAX_LENGTH = 2000;
// Validation ranges stay unchanged; scale describes PostgreSQL storage precision.
const WATER_METRIC_DEFINITIONS = Object.freeze({
    temperatureC: { inputMin: 0, inputMax: 50, scale: 2 },
    ph: { inputMin: 0, inputMax: 14, scale: 2 },
    dissolvedOxygenMgL: { inputMin: 0, inputMax: null, scale: 3 },
    salinityPpt: { inputMin: 0, inputMax: null, scale: 3 },
    nh3MgL: { inputMin: 0, inputMax: null, scale: 5 },
    no2MgL: { inputMin: 0, inputMax: null, scale: 5 },
    alkalinityMgLCaCO3: { inputMin: 0, inputMax: null, scale: 2 },
    h2sMgL: { inputMin: 0, inputMax: null, scale: 5 },
});

/**
 * Compare measured water metrics against the selected species' warning thresholds.
 * @param {string} shrimpType 'WHITELEG' | 'BLACK_TIGER', matching SHRIMP_TYPE.
 * @param {Object} values Metric values as Decimal or number; null means not measured.
 * @returns {Array<{field, direction, value, min, max, unit}>} Metrics outside their warning limits.
 */
const checkWaterThresholds = (shrimpType, values = {}) => {
    const thresholds = WATER_THRESHOLDS[shrimpType];
    if (!thresholds) {
        throw new Error(`Unknown shrimp type for water thresholds: ${shrimpType}`);
    }
    const exceeded = [];
    for (const [field, key] of Object.entries(THRESHOLD_FIELD_MAP)) {
        const raw = values[field];
        if (raw === null || raw === undefined || raw === '') continue; // Skip unmeasured metrics.
        const value = Number(raw);
        if (Number.isNaN(value)) continue;
        const { min, max, unit } = thresholds[key];
        if ((min !== null && value < min) || (max !== null && value > max)) {
            const direction = min !== null && value < min ? 'below_min' : 'above_max';
            exceeded.push({ field, direction, value, min, max, unit });
        }
    }
    return exceeded;
};

module.exports = {
    DASHBOARD_PERIOD,
    ALERT_KIND,
    RAG_STATUS,
    RAG_DOCUMENT_STATUS,
    RAG_DOCUMENT_MAX_FILE_BYTES,
    RAG_DOCUMENT_EXTENSIONS,
    RAG_DOCUMENT_CATEGORIES,
    RAG_UPLOAD_SIGNATURE_TTL_MS,
    RAG_UPLOAD_CLEANUP_DELAY_MS,
    RAG_DOCUMENT_ERRORS,
    httpStatus,
    messages,
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    VERIFICATION_PURPOSE,
    SHRIMP_TYPE,
    SEASON_STATUS,
    PERSONNEL_ROLE,
    OPERATION_TYPE,
    OPERATION_STATUS,
    DOSE_BASIS,
    PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES,
    PRODUCTION_PROTOCOL_WRITABLE_SEASONS,
    PRODUCTION_PROTOCOL_UNITS,
    PRODUCTION_PROTOCOL_CATEGORIES,
    allowedProductionProtocolDoseBases,
    SCHEDULE_CANCELLATION_TYPE,
    NOTIFICATION_TYPE,
    WATER_THRESHOLDS,
    THRESHOLD_FIELD_MAP,
    WATER_METRIC_DEFINITIONS,
    WATER_METRICS_POLICY_VERSION,
    WATER_RECORDED_AT_FUTURE_TOLERANCE_SECONDS,
    WATER_NOTE_MAX_LENGTH,
    checkWaterThresholds,
    PRODUCT_CATEGORY,
    PRODUCT_UNIT,
    CONVERSION_UNIT,
    INVENTORY_TRANSACTION_TYPE,
    OWNER_INVENTORY_TRANSACTION_TYPES,
    PRODUCT_STOCK_STATUS,
    PRODUCT_ARCHIVE_STATUS,
    INVENTORY_LIMITS,
    HARVEST_MESSAGES,
};
