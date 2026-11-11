const ApiError = require('./ApiError');
const { messages } = require('../constants');
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

const assertTreatmentFirstStage = stages => {
    if (stages.length && stages[0].startDayOffset !== 0)
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_STAGE_DAY);
};

/** Stored item days are one-based. Approval and activation must not invent an empty treatment day 1. */
const assertTreatmentCourse = (protocol, season, options = {}) => {
    assertTreatmentStart(protocol.treatmentStartAt, season, { ...options, required: true });
    if (!protocol.summary?.trim()) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.INSTRUCTIONS_REQUIRED);
    if (protocol.productionStructure?.stages?.[0]?.startDayOfCulture !== 1)
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_STAGE_DAY);
    let hasDayOne = false;
    for (const item of protocol.items) {
        if (!Number.isInteger(item.dueAtMinutes) || item.dueAtMinutes < 0)
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.START_REQUIRED);
        const range = occurrenceRange(item);
        if (!range.count) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.APPLICATION_DAYS);
        const firstAt = scheduledAtDay({ ...protocol, season }, item, range.first);
        if (!firstAt) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
        if (firstAt < new Date(protocol.treatmentStartAt))
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_OCCURRENCE);
        if (range.first === 1) hasDayOne = true;
    }
    if (!hasDayOne) throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.DAY_ONE_REQUIRED);
};

module.exports = { assertTreatmentStart, assertTreatmentFirstStage, assertTreatmentCourse };
