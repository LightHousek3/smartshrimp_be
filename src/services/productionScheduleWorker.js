const config = require('../config');
const logger = require('../config/logger');
const { generate, batch } = require('./productionSchedule.service');
const { PRODUCTION_PROTOCOL_LIMITS, messages } = require('../constants');
const { productionSchedule: rules } = require('../utils');
let timer, cursor, running = false;
const tick = async () => {
    if (running) return;
    running = true;
    try {
        const rows = await batch(cursor);
        for (const row of rows) {
            try { await generate(row.id); }
            catch (error) { logger.error(messages.PRODUCTION_PROTOCOL.SCHEDULE_GENERATION_ERROR(row.id, rules.errorDetail(error))); }
            cursor = row.id;
        }
        if (rows.length < PRODUCTION_PROTOCOL_LIMITS.workerBatch) cursor = undefined;
    } catch (error) { logger.error(messages.PRODUCTION_PROTOCOL.SCHEDULE_WORKER_ERROR(cursor, rules.errorDetail(error))); }
    finally { running = false; }
};
const start = () => {
    if (timer || !config.productionProtocol.v2Enabled || !config.productionProtocol.scheduleWorkerEnabled) return;
    timer = setInterval(tick, config.productionProtocol.workerIntervalMs);
    timer.unref();
    void tick();
};
const stop = () => { clearInterval(timer); timer = null; };
module.exports = { start, stop };
