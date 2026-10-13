const config = require('../config');
const logger = require('../config/logger');
const { processNext } = require('./ragDocument.service');
let timer;
let running = false;
const tick = async () => {
    if (running) return;
    running = true;
    try { await processNext(); }
    catch { logger.error('RAG document worker failed; retrying on next tick.'); }
    finally { running = false; }
};
const start = () => {
    if (timer) return;
    // One job per tick, with no overlap: at 5s, at most ~12 jobs/minute in steady
    // state when jobs finish within one interval. Longer ingestion lowers throughput.
    timer = setInterval(tick, config.rag.workerIntervalMs);
    timer.unref();
    void tick();
};
const stop = () => { clearInterval(timer); timer = null; };
module.exports = { start, stop };
