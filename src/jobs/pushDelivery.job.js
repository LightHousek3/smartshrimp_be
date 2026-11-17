const createScheduledJob = require('./createScheduledJob');
const { intervalMs } = require('../constants/pushNotification');
const { processPending } = require('../services/pushDelivery.service');

module.exports = createScheduledJob({ name: 'push-delivery', intervalMs, run: processPending });
