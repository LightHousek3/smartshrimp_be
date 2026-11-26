const createScheduledJob = require('./createScheduledJob');
const { remind } = require('../services/harvestPriceReminder.service');

module.exports = createScheduledJob({
    name: 'harvest-price-reminders',
    intervalMs: 300000,
    cronExpression: '0 */5 * * * *',
    run: remind,
});
