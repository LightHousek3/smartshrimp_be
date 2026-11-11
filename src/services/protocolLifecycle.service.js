const { ApiError } = require('../utils');
const { messages } = require('../constants');
const { courseCoverage, cultureDay } = require('../utils/protocolTimeline');
const { assertTreatmentCourse } = require('../utils/treatmentProtocolPolicy');
const { materialSelect, assertOperationalMaterial, assertApprovedMaterial } = require('./productionProtocolReview.service');

const OPEN_CASES = ['OPEN', 'MONITORING', 'IN_TREATMENT'];
// Legacy requests without a linked answer stay unresolved until explicitly reconciled.
const pendingRequests = (tx, caseId) => tx.diseaseCaseResponse.count({ where: { caseId, responseType: 'REQUEST_INFO',
    OR: [{ requestStatus: 'OPEN' }, { requestStatus: null }] } });
const event = (tx, protocol, status, eventType, changedBy, reason, eventData, at = new Date()) =>
    tx.protocolStatusHistory.create({ data: { protocolId: protocol.id, fromStatus: protocol.status,
        toStatus: status, eventType, changedBy, reason, eventData, changedAt: at } });
const transition = async (tx, protocol, status, eventType, changedBy, reason, eventData = {}, at = new Date()) => {
    const result = await tx.protocol.updateMany({ where: { id: protocol.id, status: protocol.status },
        data: { status, updatedAt: at, ...(status === 'SUPERSEDED' && { supersededAt: at }),
            ...(status === 'ABORTED' && { abortReason: reason, abortedBy: changedBy, abortedAt: at }) } });
    if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    await event(tx, protocol, status, eventType, changedBy, reason, eventData, at);
};
const cancelPlanned = (tx, protocolId, cancellationType, reason, actorId, at) => tx.operationSchedule.updateMany({
    where: { protocolItem: { protocolId }, status: 'PLANNED', execution: null },
    data: { status: 'CANCELLED', cancellationType, cancellationReason: reason,
        cancelledBy: actorId, cancelledAt: at, updatedAt: at },
});

/** Holds belong to season events, even if no production protocol exists yet. */
const activeHolds = async (tx, seasonId) => {
    const events = await tx.protocolStatusHistory.findMany({ where: { protocol: { seasonId },
        eventType: { in: ['HOLD_SET', 'HOLD_RELEASED'] } }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    const released = new Set(events.filter(row => row.eventType === 'HOLD_RELEASED').flatMap(row => row.eventData?.holdIds ?? []));
    return events.filter(row => row.eventType === 'HOLD_SET' && !released.has(row.id));
};
const hold = (tx, protocol, actorId, reason, at, extra = {}) => event(tx, protocol, protocol.status,
    'HOLD_SET', actorId, reason, extra, at);
const release = (tx, protocol, actorId, reason, holds, at) => holds.length
    ? event(tx, protocol, protocol.status, 'HOLD_RELEASED', actorId, reason, { holdIds: holds.map(row => row.id) }, at) : null;

const changeCase = async (tx, diseaseCase, status, actorId, reason, at) => {
    if (diseaseCase.status === status) return;
    const result = await tx.diseaseCase.updateMany({ where: { id: diseaseCase.id, status: diseaseCase.status },
        data: { status, updatedAt: at } });
    if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    await tx.diseaseCaseStatusHistory.create({ data: { caseId: diseaseCase.id, fromStatus: diseaseCase.status,
        toStatus: status, changedBy: actorId, reason, changedAt: at } });
};

/** Recheck mutable dependencies; approval alone cannot keep an ineligible material operational. */
const eligibleItems = async (tx, protocol, season, items) => {
    if (!items.length) return false;
    try {
        if (protocol.protocolType === 'TREATMENT' && protocol.contentVersion === 2) assertTreatmentCourse(protocol, season);
        for (const item of items) {
            assertOperationalMaterial(item.product, item, season.pond.farmId, season.pond.farm.ownerId, { ...protocol, season });
            assertApprovedMaterial(item.product, item.materialSnapshot);
        }
        return true;
    } catch (error) {
        if (error instanceof ApiError) return false;
        throw error;
    }
};

const resumeProduction = async (tx, seasonId, at) => {
    if ((await activeHolds(tx, seasonId)).length) return;
    if (await tx.protocol.count({ where: { seasonId, protocolType: 'TREATMENT', contentVersion: 1,
        status: 'APPROVED', diseaseCase: { status: 'IN_TREATMENT' } } })) return;
    if (await tx.protocol.count({ where: { seasonId, status: 'ACTIVE' } })) return;
    const season = await tx.aquacultureSeason.findUnique({ where: { id: seasonId },
        include: { pond: { include: { farm: true } } } });
    if (season?.status !== 'ACTIVE' || season.pond.farm.status !== 'ACTIVE' || !season.stockingDate) return;
    const protocol = await tx.protocol.findFirst({ where: { seasonId, protocolType: 'PRODUCTION',
        contentVersion: 2, status: { in: ['APPROVED', 'PAUSED'] } }, orderBy: { versionNo: 'desc' },
        include: { items: { include: { product: { select: materialSelect } } } } });
    if (!protocol) return;
    const doc = cultureDay(season.stockingDate, at);
    if (doc < 1) return;
    if (!await eligibleItems(tx, protocol, season, protocol.items.filter(item => item.endDayOffset >= doc))) return;
    const previous = await tx.protocol.findMany({ where: { seasonId, protocolType: 'PRODUCTION',
        id: { not: protocol.id }, status: 'PAUSED' } });
    for (const row of previous) {
        await transition(tx, row, 'SUPERSEDED', 'SUPERSEDED', null, 'Bản nuôi mới tiếp quản.', {}, at);
        await cancelPlanned(tx, row.id, 'PROTOCOL_SUPERSEDED', 'Bản nuôi mới tiếp quản.', null, at);
    }
    await transition(tx, protocol, 'ACTIVE', 'ACTIVATED', null, 'Phác đồ nuôi tiếp tục theo DOC hiện tại.', {}, at);
};

/** Called under the season lock; approval never cuts the previous course short. */
const reconcile = async (tx, seasonId, now = new Date()) => {
    const season = await tx.aquacultureSeason.findUnique({ where: { id: seasonId },
        include: { pond: { include: { farm: true } } } });
    if (season?.status !== 'ACTIVE' || season.pond.farm.status !== 'ACTIVE' || !season.stockingDate) return;
    const due = await tx.protocol.findFirst({ where: { seasonId, protocolType: 'TREATMENT', contentVersion: 2,
        status: 'APPROVED', treatmentStartAt: { lte: now } }, include: { diseaseCase: true,
            items: { include: { product: { select: materialSelect } } } },
    orderBy: [{ treatmentStartAt: 'asc' }, { versionNo: 'asc' }] });
    const assignedExpert = due && await tx.seasonPersonnelAssignment.findFirst({ where: { seasonId,
        accountId: due.diseaseCase.expertId, role: 'EXPERT', unassignedAt: null,
        account: { status: 'ACTIVE', managedByOwnerId: season.pond.farm.ownerId } }, select: { id: true } });
    if (due && assignedExpert && OPEN_CASES.includes(due.diseaseCase.status) && due.reviewedAt < due.treatmentStartAt
        && await eligibleItems(tx, due, season, due.items)
        && !await pendingRequests(tx, due.diseaseCaseId)) {
        const previous = await tx.protocol.findMany({ where: { seasonId, OR: [{ status: 'ACTIVE' },
            { protocolType: 'TREATMENT', contentVersion: 1, status: 'APPROVED', diseaseCase: { status: 'IN_TREATMENT' } }] } });
        for (const row of previous) {
            const production = row.protocolType === 'PRODUCTION';
            await transition(tx, row, production ? 'PAUSED' : 'SUPERSEDED', production ? 'STATUS_CHANGED' : 'SUPERSEDED',
                null, 'Phác đồ điều trị đã duyệt bắt đầu có hiệu lực.', { replacementId: due.id }, now);
            await cancelPlanned(tx, row.id, production ? 'TREATMENT_OVERRIDE' : 'PROTOCOL_SUPERSEDED',
                'Lịch được thay bằng phác đồ điều trị có hiệu lực.', null, now);
        }
        // Legacy V1 production has no V2 snapshot; retain its approval but stop its remaining slots.
        const legacyProduction = await tx.protocol.findMany({ where: { seasonId, protocolType: 'PRODUCTION', contentVersion: 1, status: 'APPROVED' } });
        for (const row of legacyProduction) await cancelPlanned(tx, row.id, 'TREATMENT_OVERRIDE', 'Lịch được thay bằng điều trị có hiệu lực.', null, now);
        const waitingHolds = (await activeHolds(tx, seasonId)).filter(row => row.eventData?.waitingForProtocolId === due.id);
        await release(tx, due, null, 'Bản điều trị kế tiếp bắt đầu.', waitingHolds, now);
        await transition(tx, due, 'ACTIVE', 'ACTIVATED', null, 'Tới mốc Expert chỉ định và đủ điều kiện.',
            { effectiveAt: due.treatmentStartAt.toISOString() }, now);
        await changeCase(tx, due.diseaseCase, 'IN_TREATMENT', null, 'Bắt đầu phác đồ điều trị đã duyệt.', now);
    }
    const current = await tx.protocol.findFirst({ where: { seasonId, protocolType: 'TREATMENT', status: 'ACTIVE', contentVersion: 2 },
        include: { items: true, diseaseCase: true } });
    if (current) {
        const schedules = await tx.operationSchedule.findMany({ where: { protocolItem: { protocolId: current.id } }, include: { execution: true } });
        if (courseCoverage({ ...current, season }, schedules, now).complete) {
            await transition(tx, current, 'COMPLETED', 'COURSE_COMPLETED', null, messages.TREATMENT_PROTOCOL.COMPLETED, {}, now);
            await changeCase(tx, current.diseaseCase, 'MONITORING', null, 'Đủ liệu trình; theo dõi theo hướng dẫn Expert.', now);
            const next = await tx.protocol.findFirst({ where: { seasonId, protocolType: 'TREATMENT', status: 'APPROVED' } });
            if (next) await hold(tx, { ...current, status: 'COMPLETED' }, null, 'Giữ chăm sóc chuyển tiếp tới bản đã duyệt tiếp theo.',
                now, { waitingForProtocolId: next.id });
        }
    }
    await resumeProduction(tx, seasonId, now);
};

/** Expert has already been authorized and season/protocol locked by the authoring workflow. */
const stop = async (tx, protocol, diseaseCase, actorId, { reason, resumeProduction: resume }, at = new Date()) => {
    const legacyRunning = protocol.contentVersion === 1 && protocol.status === 'APPROVED' && diseaseCase.status === 'IN_TREATMENT';
    if (protocol.status !== 'ACTIVE' && !legacyRunning) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.STATE);
    if (!reason?.trim() || typeof resume !== 'boolean') throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.REASON_REQUIRED);
    await transition(tx, protocol, 'ABORTED', 'ABORTED', actorId, reason.trim(), { resumeProduction: resume }, at);
    await cancelPlanned(tx, protocol.id, 'TREATMENT_ABORTED', reason.trim(), actorId, at);
    await changeCase(tx, diseaseCase, 'MONITORING', actorId, reason.trim(), at);
    const stopped = { ...protocol, status: 'ABORTED' };
    if (!resume) await hold(tx, stopped, actorId, reason.trim(), at);
    // A resume choice cannot erase an older independent hold.
    if (resume) await resumeProduction(tx, protocol.seasonId, at);
    await tx.diseaseCaseResponse.create({ data: { caseId: diseaseCase.id, authorId: actorId,
        responseType: 'EXPERT_INSTRUCTION', message: reason.trim(), attachments: [], createdAt: at } });
    const season = await tx.aquacultureSeason.findUnique({ where: { id: protocol.seasonId },
        select: { pond: { select: { farm: { select: { ownerId: true } } } } } });
    const technicians = await tx.seasonPersonnelAssignment.findMany({ where: { seasonId: protocol.seasonId,
        role: 'TECHNICIAN', unassignedAt: null, account: { status: 'ACTIVE' } }, select: { accountId: true } });
    const recipients = new Set([season.pond.farm.ownerId, ...technicians.map(row => row.accountId)]);
    const notifications = [];
    for (const accountId of recipients) {
        const notification = await tx.notification.create({ data: { accountId,
            title: 'Expert đã dừng phác đồ điều trị', content: `${protocol.title}: ${reason.trim()}`,
            type: 'TREATMENT_PROTOCOL_ABORTED', referenceType: 'disease_case', referenceId: diseaseCase.id } });
        notifications.push({ accountId, id: notification.id });
    }
    return notifications;
};

const closeSeason = async (tx, seasonId, ownerId, cancelled, at = new Date()) => {
    const reasonCode = cancelled ? 'SEASON_CANCELLED' : 'SEASON_ENDED';
    const reason = cancelled ? 'Khép do Owner hủy vụ, không phải kết luận khỏi bệnh.' : 'Khép do Owner kết thúc vụ, không phải kết luận khỏi bệnh.';
    const protocols = await tx.protocol.findMany({ where: { seasonId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'PAUSED'] } } });
    for (const protocol of protocols) {
        const legacyUse = protocol.contentVersion === 1 && protocol.status === 'APPROVED'
            && await tx.operationExecution.count({ where: { schedule: { protocolItem: { protocolId: protocol.id } } } });
        const applied = ['ACTIVE', 'PAUSED'].includes(protocol.status) || Boolean(legacyUse);
        await transition(tx, protocol, applied ? 'COMPLETED' : 'CANCELLED', reasonCode, ownerId, reason, { reasonCode }, at);
        await cancelPlanned(tx, protocol.id, cancelled ? 'SEASON_CANCELLED' : 'SEASON_COMPLETED', reason, ownerId, at);
    }
    const cases = await tx.diseaseCase.findMany({ where: { seasonId, status: { not: 'RESOLVED' } } });
    for (const diseaseCase of cases) {
        const result = await tx.diseaseCase.updateMany({ where: { id: diseaseCase.id, status: diseaseCase.status },
            data: { status: 'RESOLVED', resolutionReason: reasonCode, resolutionSummary: reason,
                resolvedBy: ownerId, resolvedAt: at, updatedAt: at } });
        if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
        await tx.diseaseCaseStatusHistory.create({ data: { caseId: diseaseCase.id, fromStatus: diseaseCase.status,
            toStatus: 'RESOLVED', changedBy: ownerId, reason, changedAt: at } });
        await tx.diseaseCaseResponse.updateMany({ where: { caseId: diseaseCase.id, requestStatus: 'OPEN' }, data: { requestStatus: 'CANCELLED' } });
    }
};

module.exports = { reconcile, stop, closeSeason, activeHolds, release, resumeProduction, transition, cancelPlanned, pendingRequests };
