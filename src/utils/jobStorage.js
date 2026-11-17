const ApiError = require('./ApiError');
const { messages } = require('../constants');

/** Do not enable recalculation against a database whose cancellation contract has not been migrated. */
const assertCalculationStorage = async (tx) => {
    const [row] = await tx.$queryRaw`SELECT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_schedules'::regclass
        AND conname='operation_schedules_cancellation_check' AND convalidated
        AND pg_get_constraintdef(oid) LIKE '%calculation_changed%') AS ready`;
    if (!row?.ready) throw new ApiError(503, messages.JOBS.STORAGE_NOT_READY);
};

module.exports = { assertCalculationStorage };
