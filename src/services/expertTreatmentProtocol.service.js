const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages } = require('../constants');
const { forTreatment } = require('./protocolAuthoring.service');

/** Resolve only the parent identity here; every read/write is authorized again inside its transaction. */
const context = async caseId => {
    const row = await prisma.diseaseCase.findUnique({ where: { id: caseId }, select: { seasonId: true } });
    if (!row) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    return row.seasonId;
};
const getContext = async (expertId, caseId) => forTreatment(caseId).getSeason(expertId, await context(caseId));
const detail = async (expertId, caseId, protocolId) => forTreatment(caseId).detail(expertId, await context(caseId), protocolId);
const create = async (expertId, caseId, body) => forTreatment(caseId).create(expertId, await context(caseId), body);
const update = async (expertId, caseId, protocolId, body) => forTreatment(caseId).update(expertId, await context(caseId), protocolId, body);
const cancel = async (expertId, caseId, protocolId, body) => forTreatment(caseId).cancel(expertId, await context(caseId), protocolId, body);
const submit = async (expertId, caseId, protocolId, body) => forTreatment(caseId).submit(expertId, await context(caseId), protocolId, body);
const stop = async (expertId, caseId, protocolId, body) => forTreatment(caseId).stop(expertId, await context(caseId), protocolId, body);

module.exports = { getContext, detail, create, update, cancel, submit, stop };
