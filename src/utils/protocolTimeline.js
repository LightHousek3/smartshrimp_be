const { dateInVietnam } = require('./productionSchedule');
const { occursOn } = require('./productionProtocolV2');
const { quantityComparison, timingComparison, TIMING } = require('./protocolExecution');

const DAY_MS = 86400000;
const calendarAt = (anchor, day) => new Date(Date.parse(anchor) + (day - 1) * DAY_MS).toISOString().slice(0, 10);
const cultureDay = (stockingDate, at) => stockingDate
    ? Math.round((Date.parse(dateInVietnam(at)) - Date.parse(stockingDate.toISOString().slice(0, 10))) / DAY_MS) + 1 : null;
const anchorOf = protocol => protocol.protocolType === 'TREATMENT'
    ? protocol.treatmentStartAt && dateInVietnam(protocol.treatmentStartAt)
    : protocol.season.stockingDate?.toISOString().slice(0, 10);
const scheduledAtDay = (protocol, item, day) => {
    const anchor = anchorOf(protocol);
    return anchor && item.plannedTime ? new Date(`${calendarAt(anchor, day)}T${item.plannedTime.toISOString().slice(11, 23)}+07:00`) : null;
};

/** Arithmetic cardinality includes occurrences which the rolling worker has not materialized. */
const occurrenceRange = item => {
    const anchor = item.recurrenceAnchorDay ?? item.startDayOffset;
    const interval = item.repeatIntervalDays;
    const first = item.startDayOffset + (interval - (item.startDayOffset - anchor) % interval) % interval;
    const count = first > item.endDayOffset ? 0 : Math.floor((item.endDayOffset - first) / interval) + 1;
    return { first, last: count ? first + (count - 1) * interval : null, count };
};

const treatmentOccurrences = (protocol, now) => {
    if (!protocol.treatmentStartAt) return [];
    const today = Date.parse(dateInVietnam(now));
    const anchor = Date.parse(anchorOf(protocol));
    const rows = [];
    for (let offset = 0; offset < 3; offset++) {
        const day = Math.round((today + offset * DAY_MS - anchor) / DAY_MS) + 1;
        for (const item of protocol.items) {
            if (!item.plannedTime || !occursOn(item, day)) continue;
            const scheduledAt = scheduledAtDay(protocol, item, day);
            if (scheduledAt < protocol.treatmentStartAt || scheduledAt < now
                && (item.dueAtMinutes == null || now.getTime() > scheduledAt.getTime() + item.dueAtMinutes * 60000)) continue;
            rows.push({ item, doc: day, cultureDay: cultureDay(protocol.season.stockingDate, scheduledAt), scheduledAt });
        }
    }
    return rows;
};

/** Count each expected identity once; cancelled/missing/off-plan evidence never completes a course. */
const courseCoverage = (protocol, schedules, now = new Date()) => {
    const byItem = new Map(protocol.items.map(item => [item.id, item]));
    const expectedCount = protocol.items.reduce((sum, item) => sum + occurrenceRange(item).count, 0);
    const seen = new Set();
    let acceptedCount = 0;
    for (const schedule of schedules) {
        const item = byItem.get(schedule.protocolItemId);
        if (!item || schedule.status !== 'COMPLETED' || !schedule.execution) continue;
        const at = new Date(schedule.scheduledAt);
        const anchor = anchorOf(protocol);
        if (!anchor) continue;
        const day = Math.round((Date.parse(dateInVietnam(at)) - Date.parse(anchor)) / DAY_MS) + 1;
        if (!occursOn(item, day) || scheduledAtDay(protocol, item, day)?.getTime() !== at.getTime()) continue;
        const key = `${item.id}:${at.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const quantity = quantityComparison(schedule.plannedQuantity, schedule.execution.actualQuantity, protocol.allowedVariancePct);
        const timing = timingComparison(schedule, item.dueAtMinutes, now);
        const actualTime = new Date(schedule.execution.executedAt);
        const hasReason = !quantity?.deviated || Boolean(schedule.execution.varianceReason?.trim());
        if (quantity && !quantity.exceedsThreshold && timing.status === TIMING.ON_TIME && actualTime <= now && hasReason
            && (!protocol.treatmentStartAt || at >= protocol.treatmentStartAt)
            && schedule.execution.actualProductId === schedule.productId) acceptedCount++;
    }
    return { expectedCount, acceptedCount, outstandingCount: expectedCount - acceptedCount,
        complete: expectedCount > 0 && acceptedCount === expectedCount };
};

module.exports = { cultureDay, anchorOf, scheduledAtDay, occurrenceRange, treatmentOccurrences, courseCoverage };
