const ApiError = require('./ApiError');
const { messages, PRODUCTION_PROTOCOL_LIMITS } = require('../constants');
const { cultureDay, occurrenceRange, scheduledAtDay } = require('./protocolTimeline');

/** Drafts may omit the anchor; supplied dates still use the season's real Vietnamese calendar. */
const assertTreatmentStart = (startAt, season, { required = false, future = false, now = new Date() } = {}) => {
    if (startAt == null) {
        if (required) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.START_REQUIRED);
        return;
    }
    const start = new Date(startAt);
    if (!Number.isFinite(start.getTime()) || !season.stockingDate || cultureDay(season.stockingDate, start) < 1)
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.START_BEFORE_STOCKING);
    if (future && start <= now) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.START_REQUIRED);
};

/** Keep treatment day one fixed at the first zero-based stage offset. */
const assertTreatmentFirstStage = stages => {
    if (stages.length && stages[0].startDayOffset !== 0)
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_STAGE_DAY);
};

/** Stored item days are one-based. Approval and activation must not invent an empty treatment day 1. */
const assertTreatmentCourse = (protocol, season, options = {}) => {
    assertTreatmentStart(protocol.treatmentStartAt, season, { ...options, required: true });
    if (protocol.productionStructure?.stages?.[0]?.startDayOfCulture !== 1)
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_STAGE_DAY);
    let hasDayOne = false;
    let lastApplicationDay = 0;
    for (const item of protocol.items) {
        if (!Number.isInteger(item.dueAtMinutes) || item.dueAtMinutes < PRODUCTION_PROTOCOL_LIMITS.minDueAtMinutes)
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.DUE_WINDOW_INVALID);
        const range = occurrenceRange(item);
        if (!range.count) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.APPLICATION_DAYS);
        const firstAt = scheduledAtDay({ ...protocol, season }, item, range.first);
        if (!firstAt) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
        if (firstAt < new Date(protocol.treatmentStartAt))
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_OCCURRENCE);
        if (range.first === 1) hasDayOne = true;
        lastApplicationDay = Math.max(lastApplicationDay, range.last);
    }
    if (!hasDayOne) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.DAY_ONE_REQUIRED);
    const finalStageDay = Math.max(...protocol.productionStructure.stages.map(stage => stage.endDayOfCulture));
    if (lastApplicationDay !== finalStageDay) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.LAST_DAY_REQUIRED);
};

module.exports = { assertTreatmentStart, assertTreatmentFirstStage, assertTreatmentCourse };
