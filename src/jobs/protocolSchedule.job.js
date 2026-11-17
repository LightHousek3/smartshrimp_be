const config = require('../config');
const logger = require('../config/logger');
const createScheduledJob = require('./createScheduledJob');
const schedules = require('../services/productionSchedule.service');
const { errorDetail } = require('../utils/productionSchedule');
const { PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

/** Isolate seasons so one invalid prescription cannot stop lifecycle recovery for other farms. */
const run = async ({ isRunning }) => {
    const seen = new Set();
    let cursor,
        rows,
        nextCheckAt = Infinity,
        failed = 0,
        created = 0,
        cancelled = 0;
    do {
        const scannedAt = Date.now();
        rows = await schedules.batch(cursor);
        for (const row of rows) {
            if (!isRunning()) break;
            if (!seen.has(row.seasonId)) {
                seen.add(row.seasonId);
                try {
                    const result = await schedules.reconcileSeason(row.seasonId);
                    created += result.created ?? 0;
                    cancelled += result.cancelled ?? 0;
                } catch (error) {
                    failed++;
                    logger.error(
                        `Season ${row.seasonId} reconciliation failed: ${errorDetail(error)}`,
                    );
                }
            }
            if (row.nextCheckAt > scannedAt)
                nextCheckAt = Math.min(nextCheckAt, Math.max(Date.now() + 1, row.nextCheckAt));
            cursor = row.id;
        }
    } while (isRunning() && rows.length === PRODUCTION_PROTOCOL_LIMITS.workerBatch);
    return {
        nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : null,
        processed: seen.size,
        failed,
        created,
        cancelled,
    };
};

module.exports = createScheduledJob({
    name: 'protocol-schedules',
    intervalMs: config.productionProtocol.workerIntervalMs,
    run,
});
