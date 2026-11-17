const { dateInVietnam } = require('./productionSchedule');
const { occursOn } = require('./protocolStructure');
const { quantityComparison, timingComparison, TIMING } = require('./protocolExecution');

const DAY_MS = 86400000;
const calendarAt = (anchor, day) =>
    new Date(Date.parse(anchor) + (day - 1) * DAY_MS).toISOString().slice(0, 10);
/** Count stocking as day one using Vietnam calendar dates rather than elapsed 24-hour periods. */
const cultureDay = (stockingDate, at) =>
    stockingDate
        ? Math.round(
              (Date.parse(dateInVietnam(at)) -
                  Date.parse(stockingDate.toISOString().slice(0, 10))) /
                  DAY_MS,
          ) + 1
        : null;
/** Use the treatment start for treatment days and the stocking date for production culture days. */
const anchorOf = (protocol) =>
    protocol.protocolType === 'TREATMENT'
        ? protocol.treatmentStartAt && dateInVietnam(protocol.treatmentStartAt)
        : protocol.season.stockingDate?.toISOString().slice(0, 10);
/** Combine the prescription day and planned local time into an absolute Vietnam-time occurrence. */
const scheduledAtDay = (protocol, item, day) => {
    const anchor = anchorOf(protocol);
    return anchor && item.plannedTime
        ? new Date(
              `${calendarAt(anchor, day)}T${item.plannedTime.toISOString().slice(11, 23)}+07:00`,
          )
        : null;
};

/** Arithmetic cardinality includes occurrences which the rolling worker has not materialized. */
const occurrenceRange = (item) => {
    const anchor = item.recurrenceAnchorDay ?? item.startDayOffset;
    const interval = item.repeatIntervalDays;
    const first =
        item.startDayOffset + ((interval - ((item.startDayOffset - anchor) % interval)) % interval);
    const count =
        first > item.endDayOffset ? 0 : Math.floor((item.endDayOffset - first) / interval) + 1;
    return { first, last: count ? first + (count - 1) * interval : null, count };
};

/** The full prescription, including unmaterialized occurrences, defines its last deadline. */
const courseEndsAt = (protocol) => {
    if (!anchorOf(protocol) || !protocol.items?.length) return null;
    let last = -Infinity;
    for (const item of protocol.items) {
        const range = occurrenceRange(item);
        if (!range.count) continue;
        const scheduled = scheduledAtDay(protocol, item, range.last);
        if (!scheduled || !Number.isInteger(item.dueAtMinutes) || item.dueAtMinutes < 10)
            return null;
        last = Math.max(last, scheduled.getTime() + item.dueAtMinutes * 60000);
    }
    return Number.isFinite(new Date(last).getTime()) ? new Date(last) : null;
};

/** Locate the next real occurrence without expanding a potentially long prescription. */
const nextOccurrences = (protocol, at) => {
    const today = cultureDay(protocol.season.stockingDate, at);
    if (!today) return [];
    return protocol.items
        .flatMap((item) => {
            const { first, last, count } = occurrenceRange(item);
            if (!count || !item.plannedTime) return [];
            let day =
                first +
                Math.max(0, Math.ceil((today - first) / item.repeatIntervalDays)) *
                    item.repeatIntervalDays;
            let scheduledAt = scheduledAtDay(protocol, item, day);
            if (scheduledAt < at) {
                day += item.repeatIntervalDays;
                scheduledAt = scheduledAtDay(protocol, item, day);
            }
            return day <= last ? [{ item, doc: day, scheduledAt }] : [];
        })
        .sort((a, b) => a.scheduledAt - b.scheduledAt);
};

/** Recover still-open treatment windows across midnight without shifting their original occurrences. */
const treatmentOccurrences = (protocol, now) => {
    if (!protocol.treatmentStartAt) return [];
    const today = Date.parse(dateInVietnam(now));
    const anchor = Date.parse(anchorOf(protocol));
    const rows = [];
    const todayDay = Math.round((today - anchor) / DAY_MS) + 1;
    for (const item of protocol.items) {
        if (!item.plannedTime) continue;
        const earliest = new Date(now.getTime() - (item.dueAtMinutes ?? 0) * 60000);
        const earliestDay = Math.round((Date.parse(dateInVietnam(earliest)) - anchor) / DAY_MS) + 1;
        const first = Math.max(1, item.startDayOffset, earliestDay);
        const recurrence = item.recurrenceAnchorDay ?? item.startDayOffset;
        const start =
            first +
            ((item.repeatIntervalDays - ((first - recurrence) % item.repeatIntervalDays)) %
                item.repeatIntervalDays);
        for (
            let day = start;
            day <= Math.min(item.endDayOffset, todayDay + 2);
            day += item.repeatIntervalDays
        ) {
            const scheduledAt = scheduledAtDay(protocol, item, day);
            if (
                scheduledAt < protocol.treatmentStartAt ||
                (scheduledAt < now &&
                    (item.dueAtMinutes == null ||
                        now.getTime() > scheduledAt.getTime() + item.dueAtMinutes * 60000))
            )
                continue;
            rows.push({
                item,
                doc: day,
                cultureDay: cultureDay(protocol.season.stockingDate, scheduledAt),
                scheduledAt,
            });
        }
    }
    return rows.sort(
        (a, b) =>
            a.scheduledAt - b.scheduledAt || String(a.item.id).localeCompare(String(b.item.id)),
    );
};

/** Count each expected identity once; cancelled/missing/off-plan evidence never completes a course. */
const courseCoverage = (protocol, schedules, now = new Date()) => {
    const byItem = new Map(protocol.items.map((item) => [item.id, item]));
    const expectedCount = protocol.items.reduce(
        (sum, item) => sum + occurrenceRange(item).count,
        0,
    );
    const seen = new Set();
    let acceptedCount = 0;
    for (const schedule of schedules) {
        const item = byItem.get(schedule.protocolItemId);
        if (!item || schedule.status !== 'COMPLETED' || !schedule.execution) continue;
        const at = new Date(schedule.scheduledAt);
        const anchor = anchorOf(protocol);
        if (!anchor) continue;
        const day = Math.round((Date.parse(dateInVietnam(at)) - Date.parse(anchor)) / DAY_MS) + 1;
        if (!occursOn(item, day) || scheduledAtDay(protocol, item, day)?.getTime() !== at.getTime())
            continue;
        const key = `${item.id}:${at.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const quantity = quantityComparison(
            schedule.plannedQuantity,
            schedule.execution.actualQuantity,
            protocol.allowedVariancePct,
        );
        const timing = timingComparison(schedule, item.dueAtMinutes, now);
        const actualTime = new Date(schedule.execution.executedAt);
        const hasReason = !quantity?.deviated || Boolean(schedule.execution.varianceReason?.trim());
        if (
            quantity &&
            !quantity.exceedsThreshold &&
            timing.status === TIMING.ON_TIME &&
            actualTime <= now &&
            hasReason &&
            (!protocol.treatmentStartAt || at >= protocol.treatmentStartAt) &&
            schedule.execution.actualProductId === schedule.productId
        )
            acceptedCount++;
    }
    return {
        expectedCount,
        acceptedCount,
        outstandingCount: expectedCount - acceptedCount,
        complete: expectedCount > 0 && acceptedCount === expectedCount,
    };
};

module.exports = {
    cultureDay,
    anchorOf,
    scheduledAtDay,
    occurrenceRange,
    treatmentOccurrences,
    courseCoverage,
    courseEndsAt,
    nextOccurrences,
};
