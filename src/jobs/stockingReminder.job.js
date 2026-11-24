const createScheduledJob = require('./createScheduledJob');
const { remind, STOCKING_REMINDER_HOUR } = require('../services/stockingReminder.service');

module.exports = createScheduledJob({
    name: 'stocking-reminders',
    intervalMs: 86400000,
    cronExpression: `0 0 ${Number(STOCKING_REMINDER_HOUR)} * * *`,
    run: remind,
});
