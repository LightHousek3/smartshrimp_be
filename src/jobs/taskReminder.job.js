const createScheduledJob = require('./createScheduledJob');
const { remind } = require('../services/taskReminder.service');

module.exports = createScheduledJob({ name: 'task-reminders', intervalMs: 60000, run: remind });
