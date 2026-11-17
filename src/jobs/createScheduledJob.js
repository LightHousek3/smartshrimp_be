const cron = require('node-cron');
const logger = require('../config/logger');
const { errorDetail } = require('../utils/productionSchedule');

const MAX_TIMEOUT = 2147483647;

/** Share one in-flight promise across startup, cron, source changes and deadline wakeups. */
module.exports = ({ name, intervalMs, cronExpression, run }) => {
    let task,
        current,
        deadline,
        wakeup,
        started = false,
        pending = false,
        lastRun = 0;
    const seconds = intervalMs / 1000;
    const aligned =
        Number.isInteger(seconds) &&
        (seconds === 60 || (seconds > 0 && seconds < 60 && 60 % seconds === 0));
    const expression =
        cronExpression ??
        (Number.isInteger(seconds) && seconds < 60 && 60 % seconds === 0
            ? `*/${seconds} * * * * *`
            : seconds === 60
              ? '0 * * * * *'
              : '* * * * * *');

    const execute = (reason = 'manual') => {
        if (current) {
            if (reason === 'event') pending = true;
            return current;
        }
        clearTimeout(deadline);
        lastRun = Date.now();
        current = Promise.resolve()
            .then(() => run({ reason, now: new Date(lastRun), isRunning: () => started }))
            .then((result) => {
                logger.info(
                    `Background job ${name} finished (${reason}) in ${Date.now() - lastRun}ms: ${JSON.stringify(result ?? {})}`,
                );
                if (started && result?.nextCheckAt != null) {
                    const delay = result.nextCheckAt - Date.now();
                    deadline = setTimeout(
                        () => execute('deadline'),
                        Math.min(MAX_TIMEOUT, delay > 0 ? delay : intervalMs),
                    );
                    deadline.unref();
                }
                return result;
            })
            .catch((error) => logger.error(`Background job ${name} failed: ${errorDetail(error)}`))
            .finally(() => {
                current = null;
                if (started && pending) {
                    pending = false;
                    request();
                }
            });
        return current;
    };

    /** Coalesce changes received during a sweep without dropping the final requested refresh. */
    const request = () => {
        if (!started) return;
        if (current) {
            pending = true;
            return;
        }
        if (wakeup) return;
        wakeup = setTimeout(() => {
            wakeup = null;
            execute('event');
        }, 0);
        wakeup.unref();
    };

    const start = () => {
        if (started) return current;
        started = true;
        task = cron.createTask(
            expression,
            () => {
                if (cronExpression || aligned || Date.now() - lastRun >= intervalMs)
                    return execute('cron');
            },
            { name, timezone: 'Asia/Ho_Chi_Minh', noOverlap: true },
        );
        task.start();
        return execute('startup');
    };

    const stop = () => {
        started = false;
        pending = false;
        task?.destroy();
        task = null;
        clearTimeout(deadline);
        clearTimeout(wakeup);
        wakeup = null;
        return current ?? Promise.resolve();
    };

    return { start, stop, request, runOnce: execute };
};
