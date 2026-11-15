const ApiError = require('../utils/ApiError');
const { messages } = require('../constants');

/** A draft is unpublished only when it has neither submission nor review history. */
const isUnsubmittedDraft = row => row.status === 'DRAFT' && !row.submittedAt && !row.reviewedAt;

/** Delete only an unpublished last aggregate; callers already hold its authorized season lock. */
const tryRemove = async (tx, row) => {
    if (!isUnsubmittedDraft(row)) return false;
    const [latest, schedules, successor, published] = await Promise.all([
        tx.protocol.findFirst({ where: { seasonId: row.seasonId, protocolType: row.protocolType, diseaseCaseId: row.diseaseCaseId },
            orderBy: { versionNo: 'desc' }, select: { id: true } }),
        tx.operationSchedule.count({ where: { protocolItem: { protocolId: row.id } } }),
        tx.protocol.count({ where: { supersedesProtocolId: row.id } }),
        tx.protocolStatusHistory.count({ where: { protocolId: row.id, OR: [{ eventType: { not: 'STATUS_CHANGED' } }, { toStatus: { not: 'DRAFT' } }] } }),
    ]);
    if (latest?.id !== row.id || schedules || successor || published) return false;
    await tx.protocolItem.deleteMany({ where: { protocolId: row.id } });
    await tx.protocolStatusHistory.deleteMany({ where: { protocolId: row.id } });
    const removed = await tx.protocol.deleteMany({ where: { id: row.id, status: 'DRAFT', submittedAt: null, reviewedAt: null } });
    if (removed.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    return true;
};

module.exports = { isUnsubmittedDraft, tryRemove };
