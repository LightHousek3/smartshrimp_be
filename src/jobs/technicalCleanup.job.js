const createScheduledJob = require('./createScheduledJob');
const { cleanup } = require('../services/technicalCleanup.service');

module.exports = createScheduledJob({
    name: 'technical-cleanup',
    intervalMs: 86400000,
    cronExpression: '0 0 3 * * *',
    run: cleanup,
});
