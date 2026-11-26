const logger = require('../config/logger');
const prisma = require('../config/prisma');
const { assertCalculationStorage } = require('../utils/jobStorage');
const schedules = require('./protocolSchedule.job');
const reminders = require('./operationReminder.job');
const documents = require('./ragDocument.job');
const tasks = require('./taskReminder.job');
const inventory = require('./inventoryReminder.job');
const harvest = require('./harvestReminder.job');
const harvestPrices = require('./harvestPriceReminder.job');
const stocking = require('./stockingReminder.job');
const cleanup = require('./technicalCleanup.job');
const push = require('./pushDelivery.job');
const firebase = require('../services/firebaseMessaging.service');
const { HARVEST_POLICY } = require('../constants');
const scheduledJobs = [schedules, reminders, documents, tasks, inventory, harvest, stocking, cleanup,
    ...(HARVEST_POLICY.priceReminderEnabled && HARVEST_POLICY.priceConfirmationEnabled ? [harvestPrices] : []),
];

let started = false,
    starting,
    generation = 0;

/** Validate storage before opening timers; callers must attach realtime delivery first. */
const start = () => {
    if (starting) return starting;
    if (started) return;
    const token = generation;
    starting = (async () => {
        await prisma.$transaction((tx) => assertCalculationStorage(tx));
        await prisma.$transaction(async (tx) => {
            const [row] =
                await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                AND table_name='products' AND column_name='low_stock_alerted_at' AND data_type='timestamp with time zone') AS ready`;
            if (!row?.ready)
                throw new Error('Missing required products.low_stock_alerted_at storage.');
        });
        if (firebase.configured())
            await prisma.$queryRaw`SELECT push_status, push_attempts, push_next_attempt_at FROM notifications LIMIT 0`;
        if (token !== generation) return;
        started = true;
        scheduledJobs.forEach((job) => void job.start());
        if (firebase.configured()) {
            void push.start();
        } else
            logger.info(
                'Push delivery awaits Firebase project and server credentials; inbox and realtime remain available.',
            );
        logger.info('Background jobs started.');
    })().finally(() => {
        starting = null;
    });
    return starting;
};

/** Wake after commit; a full sweep retains deadlines belonging to other seasons. */
const requestSeason = (seasonId) => {
    if (started && seasonId) schedules.request();
};
const stop = async () => {
    generation++;
    started = false;
    await Promise.all([starting, push.stop(), ...scheduledJobs.map((job) => job.stop())]);
};

module.exports = { start, stop, requestSeason };
