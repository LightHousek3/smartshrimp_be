const createScheduledJob = require('./createScheduledJob');
const { remind } = require('../services/operationReminder.service');

let bootAt;
const job = createScheduledJob({
    name: 'operation-reminders',
    intervalMs: 60000,
    run: (context) => remind({ ...context, bootAt }),
});

module.exports = {
    ...job,
    start: () => {
        bootAt ??= new Date();
        return job.start();
    },
};
