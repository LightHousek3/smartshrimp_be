const config = require('../config');
const createScheduledJob = require('./createScheduledJob');
const { processNext } = require('../services/ragDocument.service');

// Claim, fencing and retry policy remain in the document service, shared by every process.
module.exports = createScheduledJob({
    name: 'rag-documents',
    intervalMs: config.rag.workerIntervalMs,
    run: () => processNext(),
});
