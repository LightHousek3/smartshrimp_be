const lifecycle = require('./protocolLifecycle.service');
const { courseEndsAt } = require('../utils/protocolTimeline');
const { messages } = require('../constants');
const { materialSelect } = require('./productionProtocolReview.service');

const EVENT = 'CARE_DECIDED';

/** Derive care actions for the current suspension without reusing a previous course's decision. */
const context = async (tx, diseaseCase, at = new Date()) => {
    const holds = await lifecycle.activeHolds(tx, diseaseCase.seasonId);
    const own = holds.filter(row => row.eventData?.diseaseCaseId === diseaseCase.id);
    const episode = own.at(-1);
    const result = { productionHolds: holds, care: { available: false, canMonitor: false, episodeId: episode?.id ?? null,
        holdIds: own.map(row => row.id), productionPaused: await lifecycle.productionPaused(tx, diseaseCase.seasonId, holds) },
    resolution: { blockedReason: null, confirmWithoutProduction: false } };
    if (diseaseCase.status === 'RESOLVED' || diseaseCase.season?.status !== 'ACTIVE') return result;
    if (diseaseCase.status === 'IN_TREATMENT') {
        result.resolution.blockedReason = messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK;
        return result;
    }
    if (!episode) {
        if (holds.length) result.resolution.blockedReason = messages.TREATMENT_PROTOCOL.CARE_INDEPENDENT_HOLD;
        return result;
    }
    const continuation = await tx.protocol.findFirst({ where: { diseaseCaseId: diseaseCase.id, protocolType: 'TREATMENT',
        status: 'APPROVED', contentVersion: 2, treatmentStartAt: { gt: at } }, include: {
        items: { include: { product: { select: materialSelect } } }, diseaseCase: true,
        season: { include: { pond: { include: { farm: true } } } } }, orderBy: { versionNo: 'desc' } });
    const continuationEnd = continuation && courseEndsAt(continuation);
    const waiting = Boolean(continuationEnd && continuationEnd > at && await lifecycle.treatmentEligible(tx, continuation, continuation.season));
    const decisions = await tx.protocolStatusHistory.findMany({ where: { eventType: EVENT,
        protocol: { seasonId: diseaseCase.seasonId }, eventData: { path: ['episodeId'], equals: episode.id } } });
    const readiness = await lifecycle.productionReadiness(tx, diseaseCase.seasonId, at, { ignoreHoldIds: own.map(row => row.id), calculate: true });
    const production = { ...readiness };
    delete production.protocol;
    delete production.season;
    result.care = { ...result.care, available: !waiting, canMonitor: !waiting && !decisions.some(row => row.eventData?.action === 'MONITOR'),
        waitingForTreatmentId: waiting ? continuation.id : null, production,
        unavailableReason: waiting ? messages.TREATMENT_PROTOCOL.CARE_CONTINUATION : null };
    result.resolution = { blockedReason: readiness.canCloseWithoutProduction ? null : readiness.canResume
        ? messages.TREATMENT_PROTOCOL.CARE_RESUME_BEFORE_CLOSE : readiness.message,
    confirmWithoutProduction: readiness.canCloseWithoutProduction };
    return result;
};

/** Link a care decision to its conversation entry without changing the protocol's terminal status. */
const record = (tx, protocol, actorId, action, episodeId, responseId, holdIds, reason, at) => tx.protocolStatusHistory.create({
    data: { protocolId: protocol.id, fromStatus: protocol.status, toStatus: protocol.status, eventType: EVENT,
        changedBy: actorId, changedAt: at, reason, eventData: { action, episodeId, responseId, holdIds } },
});

/** Identify care entries by their audit references rather than by matching message text. */
const annotate = async (tx, responses = []) => {
    if (!responses.length) return responses;
    const events = await tx.protocolStatusHistory.findMany({ where: { eventType: EVENT,
        OR: responses.map(row => ({ eventData: { path: ['responseId'], equals: row.id } })) }, select: { eventData: true } });
    const actions = new Map(events.map(row => [row.eventData?.responseId, row.eventData?.action]));
    return responses.map(row => actions.has(row.id) ? { ...row, careAction: actions.get(row.id) } : row);
};

module.exports = { context, record, annotate };
