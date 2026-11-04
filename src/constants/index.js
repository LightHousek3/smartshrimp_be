const httpStatus = require('./httpStatus');
const messages = require('./messages');
const NOTIFICATION_TYPE = require('./notificationType');
const { FarmStatus: FARM_STATUS } = require('@prisma/client');
const HARVEST_ERROR_CODE = Object.freeze({
    TIME_NOT_AFTER_LATEST: 'HARVEST_TIME_NOT_AFTER_LATEST',
    PARTIAL_COUNT_REQUIRED: 'HARVEST_PARTIAL_COUNT_REQUIRED',
    POPULATION_UNKNOWN: 'HARVEST_POPULATION_UNKNOWN',
    POPULATION_MISMATCH: 'HARVEST_POPULATION_MISMATCH',
    WITHDRAWAL_UNKNOWN: 'HARVEST_WITHDRAWAL_UNKNOWN',
    WITHDRAWAL_ACTIVE: 'HARVEST_WITHDRAWAL_ACTIVE',
    VARIANCE_REASON_REQUIRED: 'HARVEST_VARIANCE_REASON_REQUIRED',
});
// Enable only after the v2 compliance/snapshot schema and legacy review are ready.
const HARVEST_POLICY = Object.freeze({ withdrawalEnabled: true });
const HARVEST_LIMITS = Object.freeze({ noteMaxLength: 500, legacyNoteMaxLength: 5000 });

// Advisory defaults, not harvest eligibility rules. Approximate months as 30 days.
// FAO: whiteleg partial harvest commonly starts after 3 months;
// black tiger grow-out typically lasts 4–5 months with water exchange.
// https://www.fao.org/fishery/docs/DOCUMENT/aquaculture/CulturedSpecies/file/en/en_whitelegshrimp.htm
// https://www.fao.org/fishery/docs/CDrom/aquaculture/I1129m/file/en/en_gianttigerprawn.htm
const harvestWarningDays = (name, fallback) => {
    const value = process.env[name];
    if (value == null || value.trim() === '') return fallback;
    const days = Number(value);
    return Number.isSafeInteger(days) && days >= 0 ? days : fallback;
};
const SHRIMP_CULTIVATION = Object.freeze({
    WHITELEG: Object.freeze({ typicalHarvestMinDays: harvestWarningDays('HARVEST_WHITELEG_WARNING_MIN_DAYS', 90) }),
    BLACK_TIGER: Object.freeze({ typicalHarvestMinDays: harvestWarningDays('HARVEST_BLACK_TIGER_WARNING_MIN_DAYS', 120) }),
});

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

const TASK_OPEN_STATUSES = Object.freeze(['PENDING', 'IN_PROGRESS']);
const TASK_STATUSES = Object.freeze([...TASK_OPEN_STATUSES, 'COMPLETED', 'CANCELLED']);
const TASK_LIMITS = Object.freeze({
    TITLE: 255,
    DESCRIPTION: 500,
    CANCELLATION_REASON: 500,
    DEADLINE_LEAD_MS: 10 * 60 * 1000,
});

const PERSONNEL_ROLE = {
    TECHNICIAN: 'TECHNICIAN',
    EXPERT: 'EXPERT',
};

const HEALTH_STATUS = Object.freeze({
    EXCELLENT: 'EXCELLENT',
    GOOD: 'GOOD',
    WARNING: 'WARNING',
    CRITICAL: 'CRITICAL',
});

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

const PRODUCT_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
});

const INVENTORY_LIMITS = Object.freeze({
    MAX_BALANCE_QUANTITY: '99999999999.999999999',
    MAX_TRANSACTION_AMOUNT: '9999999999999999.99',
    SCHEMA_CACHE_MS: 30000,
    REVIEW_NOTE_MAX_LENGTH: 5000,
});

const PRODUCT_COMPLIANCE_STATUS = Object.freeze({
    DRAFT: 'draft',
    REVIEWED: 'reviewed',
    BLOCKED: 'blocked',
});

const PRODUCT_REGULATORY_TYPE = Object.freeze({
    UNCLASSIFIED: 'unclassified',
    FEED: 'feed',
    ENVIRONMENT: 'environment',
    DUAL_PURPOSE: 'dual_purpose',
    MEDICINE: 'medicine',
});

const DOSE_BASIS = {
    FIXED_QUANTITY: 'FIXED_QUANTITY',
    PER_KG_BIOMASS: 'PER_KG_BIOMASS',
    PERCENT_BIOMASS: 'PERCENT_BIOMASS',
    PER_M3_WATER: 'PER_M3_WATER',
};

const PROTOCOL_TYPE = Object.freeze({
    PRODUCTION: 'PRODUCTION',
    TREATMENT: 'TREATMENT',
});
const PROTOCOL_STATUS = Object.freeze({
    DRAFT: 'DRAFT',
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    SUPERSEDED: 'SUPERSEDED',
    CANCELLED: 'CANCELLED',
    ABORTED: 'ABORTED',
});

const PRODUCTION_PROTOCOL_EDITABLE_STATUSES = ['DRAFT', 'REJECTED'];
const PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES = [
    ...PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    'PENDING_APPROVAL',
];
const PRODUCTION_PROTOCOL_WRITABLE_SEASONS = [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE];
const PRODUCTION_PROTOCOL_UNITS = ['KG', 'G', 'L', 'ML', 'PACK', 'BOTTLE', 'PCS'];
const PRODUCTION_PROTOCOL_CATEGORIES = ['FEED', 'MEDICINE', 'MINERAL', 'CHEMICAL', 'OTHER'];
const PRODUCTION_PROTOCOL_LIMITS = Object.freeze({ stages: 120, items: 1000, workerBatch: 20,
    materialOptions: 50, biomassMaxAgeHours: 24, structureVersion: 1, maxDoc: 2147483647 });

const allowedProductionProtocolDoseBases = (operationType, offset) => {
    if ([OPERATION_TYPE.FEEDING, OPERATION_TYPE.MEDICINE].includes(operationType)) {
        // API offsets are zero-based; the persisted DOC 30 boundary is offset 29.
        return offset >= 29
            ? [DOSE_BASIS.FIXED_QUANTITY, DOSE_BASIS.PERCENT_BIOMASS, DOSE_BASIS.PER_KG_BIOMASS]
            : [DOSE_BASIS.FIXED_QUANTITY];
    }
    if (operationType === OPERATION_TYPE.OTHER && offset >= 30) {
        return Object.values(DOSE_BASIS);
    }

    return [DOSE_BASIS.FIXED_QUANTITY, DOSE_BASIS.PER_M3_WATER];
};

const SCHEDULE_CANCELLATION_TYPE = {
    PROTOCOL_SUPERSEDED: 'PROTOCOL_SUPERSEDED',
    TREATMENT_ABORTED: 'TREATMENT_ABORTED',
    SEASON_CANCELLED: 'SEASON_CANCELLED',
    SEASON_COMPLETED: 'SEASON_COMPLETED',
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
const RAG_DOCUMENT_ASSET_FOLDER = 'smartshrimp/documents';
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
 * Ngưỡng cảnh báo chất lượng nước theo loại tôm, dùng cho:
 *  - F1 "Nhập nhật ký đo nước": so sánh từng chỉ số lúc nhập, vượt ngưỡng ->
 *    tạo notification `water_threshold_exceeded` cho chủ trại (BR-NOTI-03).
 *  - F4 "Xem thống kê chất lượng nước": tính % mẫu vượt ngưỡng.
 *
 * NGUỒN SỐ LIỆU (DRAFT 2026-10-08): tổng hợp từ tài liệu trực tuyến
 * (tôm thẻ chân trắng L. vannamei; tôm sú P. monodon).
 * ⚠️ TEAM NUÔI TRỒNG BẮT BUỘC rà soát và điều chỉnh trước khi dùng production.
 *
 * Quy ước: vượt ngưỡng = giá trị nằm NGOÀI [min, max].
 * Các chỉ số một phía (vd. NH3 chỉ có max) thì phía còn lại để null = không giới hạn.
 * Đây là ngưỡng CẢNH BÁO vận hành, khác với khoảng vật lý ở DB CHECK
 * (temp 0–50, pH 0–14, các chỉ số ≥ 0) — DB CHECK vẫn là tuyến phòng thủ cuối.
 *
 * Lưu ý về NH3: cột `nh3_mg_l` trong DB chưa rõ là NH3 tự do hay TAN
 * (total ammonia nitrogen). Ngưỡng dưới đây áp cho giá trị đo thực tế được nhập;
 * team cần chốt định nghĩa cột, lý tưởng là quy đổi NH3 tự do từ TAN + pH + nhiệt độ.
 */

// Dùng đúng key SHRIMP_TYPE của src/constants/index.js: WHITELEG / BLACK_TIGER
const WATER_THRESHOLDS = {
    WHITELEG: {
        // Tôm thẻ chân trắng (Litopenaeus vannamei)
        // Nguồn: tổng hợp nhiều nghiên cứu — temp tối ưu 25–33 (tốt nhất 28–30);
        // pH 7.5–8.5; DO > 4 (tối ưu ≥ 5); độ mặn 15–25 (chịu được 5–35);
        // NH3 < 0.1; NO2 < 0.5; kiềm > 120; H2S < 0.05.
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
        // Tôm sú (Penaeus monodon)
        // Nguồn: tổng hợp nhiều nghiên cứu — temp tối ưu 26–32 (tốt nhất 26–29);
        // pH 7.5–8.5; DO tối thiểu 4; độ mặn 10–25 (chịu được 5–32);
        // NH3-N tối đa 0.1; NO2-N tối đa 0.5–1.0 (lấy mức chặt 0.5);
        // H2S < 0.05; kiềm 100–200.
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

// Map tên field camelCase (BE) -> key ngưỡng, để loop kiểm tra.
// Thêm/xóa chỉ số đo trong tương lai chỉ cần sửa map này + WATER_THRESHOLDS.
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
 * Kiểm tra các chỉ số đo so với ngưỡng của loại tôm.
 * @param {string} shrimpType 'WHITELEG' | 'BLACK_TIGER' (đúng enum SHRIMP_TYPE)
 * @param {Object} values object các chỉ số (Decimal hoặc number, null = không đo)
 * @returns {Array<{field, direction, value, min, max, unit}>} danh sách chỉ số vượt ngưỡng
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
    FARM_STATUS,
    HARVEST_POLICY,
    HARVEST_LIMITS,
    HARVEST_ERROR_CODE,
    SHRIMP_CULTIVATION,
    DASHBOARD_PERIOD,
    ALERT_KIND,
    RAG_STATUS,
    RAG_DOCUMENT_STATUS,
    RAG_DOCUMENT_MAX_FILE_BYTES,
    RAG_DOCUMENT_ASSET_FOLDER,
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
    TASK_OPEN_STATUSES,
    TASK_STATUSES,
    TASK_LIMITS,
    PERSONNEL_ROLE,
    HEALTH_STATUS,
    OPERATION_TYPE,
    OPERATION_STATUS,
    DOSE_BASIS,
    PROTOCOL_TYPE,
    PROTOCOL_STATUS,
    PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES,
    PRODUCTION_PROTOCOL_WRITABLE_SEASONS,
    PRODUCTION_PROTOCOL_UNITS,
    PRODUCTION_PROTOCOL_CATEGORIES,
    PRODUCTION_PROTOCOL_LIMITS,
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
    PRODUCT_STATUS,
    INVENTORY_LIMITS,
    PRODUCT_COMPLIANCE_STATUS,
    PRODUCT_REGULATORY_TYPE,
};
