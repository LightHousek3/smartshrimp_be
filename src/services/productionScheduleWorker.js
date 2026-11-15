const config = require('../config');
const logger = require('../config/logger');
const { generate, batch } = require('./productionSchedule.service');
const { PRODUCTION_PROTOCOL_LIMITS, messages } = require('../constants');
const { productionSchedule: rules } = require('../utils');
let timer, deadlineTimer, running = false;
/** Drain protocol batches without overlapping sweeps, then schedule the nearest lifecycle deadline. */
const tick = async () => {
    if (running) return;
    running = true;
    let cursor, nextCheckAt = Infinity;
    clearTimeout(deadlineTimer);
    try {
        let rows;
        do {
            rows = await batch(cursor);
            for (const row of rows) {
                let failed = false;
                try { await generate(row.id); }
                catch (error) { failed = true; logger.error(messages.PRODUCTION_PROTOCOL.SCHEDULE_GENERATION_ERROR(row.id, rules.errorDetail(error))); }
                // Failed expired plans wait for the retry interval instead of spinning immediately.
                if (row.nextCheckAt != null) nextCheckAt = Math.min(nextCheckAt,
                    failed ? Math.max(row.nextCheckAt, Date.now() + config.productionProtocol.workerIntervalMs) : row.nextCheckAt);
                cursor = row.id;
            }
        } while (timer && rows.length === PRODUCTION_PROTOCOL_LIMITS.workerBatch);
    } catch (error) { logger.error(messages.PRODUCTION_PROTOCOL.SCHEDULE_WORKER_ERROR(cursor, rules.errorDetail(error))); }
    finally {
        running = false;
        if (timer && Number.isFinite(nextCheckAt)) {
            // Node timers overflow above int32; shutdown must not rearm this timeout.
            deadlineTimer = setTimeout(tick, Math.min(2147483647, Math.max(1, nextCheckAt - Date.now())));
            deadlineTimer.unref();
        }
    }
};
/** Start one periodic sweep and recover any lifecycle transitions missed while the server was offline. */
const start = () => {
    if (timer || !config.productionProtocol.v2Enabled || !config.productionProtocol.scheduleWorkerEnabled) return;
    timer = setInterval(tick, config.productionProtocol.workerIntervalMs);
    timer.unref();
    void tick();
};
/** Cancel both wakeup sources so a finishing sweep cannot restart the worker. */
const stop = () => { clearInterval(timer); clearTimeout(deadlineTimer); timer = null; };
module.exports = { start, stop };
