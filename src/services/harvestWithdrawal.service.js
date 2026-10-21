const { Prisma } = require('@prisma/client');
const { ApiError } = require('../utils');
const { HARVEST_POLICY, HARVEST_ERROR_CODE, messages } = require('../constants');
const M = messages.HARVEST;

const withdrawalError = (message, errorCode) => {
    const error = ApiError.badRequest(message);
    error.errorCode = errorCode;
    return error;
};

/**
 * S08 uses immutable execution snapshots, including fractional 24-hour days.
 * The caller holds the season lock shared with S07. Later corrections can only
 * extend protection; cancelled schedules never erase a recorded use.
 */
const checkHarvest = async (tx, seasonId, harvestedAt) => {
    if (!HARVEST_POLICY.withdrawalEnabled) return M.WITHDRAWAL_UNVERIFIED_WARNING;
    const [state] = await tx.$queryRaw(Prisma.sql`SELECT
        coalesce(bool_or((e.withdrawal_days_snapshot IS NULL OR c.withdrawal_days IS NULL) AND
            (p.category = 'medicine' OR c.regulatory_type = 'medicine' OR s.operation_type = 'medicine')), false) AS unknown,
        coalesce(bool_or(p.id IS NULL OR c.product_id IS NULL OR c.compliance_status <> 'reviewed'), false) AS unsafe,
        coalesce(bool_or(${harvestedAt}::timestamptz <
            e.executed_at + GREATEST(e.withdrawal_days_snapshot, c.withdrawal_days) * INTERVAL '24 hours'), false) AS blocked
        FROM operation_executions e JOIN operation_schedules s ON s.id = e.schedule_id
        LEFT JOIN products p ON p.id = coalesce(e.actual_product_id, s.product_id)
        LEFT JOIN product_compliance c ON c.product_id = p.id
        WHERE s.season_id = ${seasonId}::uuid`);
    if (!state || state.unknown) throw withdrawalError(M.WITHDRAWAL_UNKNOWN, HARVEST_ERROR_CODE.WITHDRAWAL_UNKNOWN);
    if (state.unsafe) throw withdrawalError(M.WITHDRAWAL_PRODUCT_NOT_READY, HARVEST_ERROR_CODE.WITHDRAWAL_UNKNOWN);
    if (state.blocked) throw withdrawalError(M.WITHDRAWAL_ACTIVE, HARVEST_ERROR_CODE.WITHDRAWAL_ACTIVE);
    return null;
};

/**
 * S07 reads the actual substituted product under its row lock, before stock
 * writes. Raw SQL keeps the compliance read and product row lock together.
 */
const prepareExecution = async (tx, seasonId, productId, operationType, executedAt, protocol = {}) => {
    if (!HARVEST_POLICY.withdrawalEnabled) return undefined;
    if (!Number.isFinite(executedAt.getTime()) || executedAt > new Date()) {
        throw ApiError.badRequest(M.WITHDRAWAL_EXECUTION_TIME);
    }
    if (!productId) {
        if (operationType === 'MEDICINE') throw ApiError.badRequest(M.WITHDRAWAL_PRODUCT_NOT_READY);
        return null;
    }
    const [product] = await tx.$queryRaw(Prisma.sql`SELECT p.category, p.status,
        c.regulatory_type, c.compliance_status, c.withdrawal_days, c.contains_antibiotic
        FROM products p LEFT JOIN product_compliance c ON c.product_id = p.id
        JOIN ponds pond ON pond.farm_id = p.farm_id
        JOIN aquaculture_seasons season ON season.pond_id = pond.id
        WHERE p.id = ${productId}::uuid AND season.id = ${seasonId}::uuid FOR UPDATE OF p`);
    if (!product || product.status !== 'active' || product.compliance_status !== 'reviewed'
        || product.regulatory_type === 'unclassified') throw ApiError.badRequest(M.WITHDRAWAL_PRODUCT_NOT_READY);
    if (product.contains_antibiotic && (protocol.protocolType !== 'TREATMENT' || !protocol.diseaseCaseId)) {
        throw ApiError.badRequest('Vật tư có kháng sinh chỉ được dùng trong phác đồ điều trị gắn ca bệnh');
    }
    const medicine = product.category === 'medicine' || product.regulatory_type === 'medicine' || operationType === 'MEDICINE';
    if (medicine && product.withdrawal_days == null) throw ApiError.badRequest(M.WITHDRAWAL_PRODUCT_NOT_READY);
    const days = product.withdrawal_days == null ? null : new Prisma.Decimal(product.withdrawal_days);
    if (days && (!days.isFinite() || days.lt(0))) throw ApiError.badRequest(M.WITHDRAWAL_PRODUCT_NOT_READY);
    if (days != null) {
        // A newly backdated use cannot invalidate an already recorded harvest.
        const [history] = await tx.$queryRaw(Prisma.sql`SELECT EXISTS(SELECT 1 FROM harvest_events
            WHERE season_id = ${seasonId}::uuid AND harvested_at >= ${executedAt}::timestamptz
                AND harvested_at < ${executedAt}::timestamptz + ${days}::numeric * INTERVAL '24 hours') AS blocked`);
        if (!history || history.blocked) throw ApiError.badRequest(M.WITHDRAWAL_EXECUTION_TIME);
    }
    return days;
};

module.exports = { checkHarvest, prepareExecution };
