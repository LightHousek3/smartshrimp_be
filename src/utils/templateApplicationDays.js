const messages = require('../constants/messages');
const ApiError = require('./ApiError');

/** Store explicit oral application dates as compact arithmetic runs; do not create daily schedule rows. */
const applicationRuns = (item, stage) => {
    if (item.applicationDays == null)
        return [
            {
                startDay: item.firstDay ?? stage.startDay,
                endDay: item.lastDay ?? stage.endDay,
                repeatIntervalDays: item.repeatIntervalDays ?? 1,
            },
        ];
    const days = item.applicationDays;
    if (
        !Array.isArray(days) ||
        !days.length ||
        days.some(
            (day, index) =>
                !Number.isInteger(day) ||
                day < stage.startDay ||
                day > stage.endDay ||
                (index > 0 && day <= days[index - 1])
        )
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_APPLICATION_DAYS
        );
    }
    if (
        (item.dailyDoseIncrement ?? 0) > 0 &&
        days.some((day, index) => index > 0 && day !== days[index - 1] + 1)
    )
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_DAILY_INCREMENT
        );
    const runs = [];
    for (let index = 0; index < days.length; ) {
        const start = index;
        const interval =
            index + 1 < days.length ? days[index + 1] - days[index] : 1;
        if (interval <= 30) {
            while (
                index + 1 < days.length &&
                days[index + 1] - days[index] === interval
            )
                index += 1;
        }
        runs.push({
            startDay: days[start],
            endDay: days[index],
            repeatIntervalDays: Math.min(interval, 30),
        });
        index += 1;
    }
    return runs;
};

module.exports = { applicationRuns };
