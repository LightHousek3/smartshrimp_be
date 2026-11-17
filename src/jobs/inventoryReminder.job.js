const createScheduledJob = require('./createScheduledJob');
const { remind } = require('../services/inventoryReminder.service');

module.exports = createScheduledJob({
    name: 'inventory-reminders',
    intervalMs: 86400000,
    cronExpression: '0 0 8 * * *',
    run: remind,
});
