const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages } = require('../constants');
const { forTreatment } = require('./protocolAuthoring.service');

/**
 * Resolve the parent season without granting access to the case.
 * The shared workflow checks the Expert, assignment and case again inside its transactions.
 */
const context = async (caseId) => {
    const row = await prisma.diseaseCase.findUnique({
        where: { id: caseId },
        select: { seasonId: true },
    });
    if (!row) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
    return row.seasonId;
};

/** Return case-scoped authoring context and eligibility for creating the next treatment version. */
const getContext = async (expertId, caseId) =>
    forTreatment(caseId).getSeason(expertId, await context(caseId));

/** Read treatment content, execution evidence and audit history from one authorized transaction. */
const detail = async (expertId, caseId, protocolId, selectedDay) =>
    forTreatment(caseId).detail(expertId, await context(caseId), protocolId, selectedDay);

/**
 * Create the next case-bound version only when no editable or pending version is in progress.
 * Optional submission is atomic with the draft and never starts treatment itself.
 */
const create = async (expertId, caseId, body) =>
    forTreatment(caseId).create(expertId, await context(caseId), body);

/** Save only a matching DRAFT or REJECTED revision through the shared graph and dose checks. */
const update = async (expertId, caseId, protocolId, body) =>
    forTreatment(caseId).update(expertId, await context(caseId), protocolId, body);

/** Delete the latest never-submitted draft and its children only when no operational references exist. */
const remove = async (expertId, caseId, protocolId, body) =>
    forTreatment(caseId).remove(expertId, await context(caseId), protocolId, body);

/** Request Owner review of a complete future course; submission does not change clinical state. */
const submit = async (expertId, caseId, protocolId, body) =>
    forTreatment(caseId).submit(expertId, await context(caseId), protocolId, body);

/**
 * Cancel an approved unapplied plan or abort a running course using the confirmed revision.
 * The shared lifecycle applies the reason and production-care choice in the same transaction.
 */
const stop = async (expertId, caseId, protocolId, body) =>
    forTreatment(caseId).stop(expertId, await context(caseId), protocolId, body);

module.exports = { getContext, detail, create, update, remove, submit, stop };
