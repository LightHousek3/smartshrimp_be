const createScheduledJob = require('./createScheduledJob');
const { remind } = require('../services/harvestReminder.service');

module.exports = createScheduledJob({
    name: 'harvest-reminders',
    intervalMs: 86400000,
    cronExpression: '0 0 8 * * *',
    run: remind,
});
