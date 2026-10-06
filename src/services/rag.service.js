const { randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const ragClient = require('./ragClient.service');
const { ApiError } = require('../utils');
const { ACCOUNT_ROLE, ACCOUNT_STATUS, PERSONNEL_ROLE, SEASON_STATUS } = require('../constants');
const { STATUS, WARNINGS, MESSAGES } = require('../constants/rag');

const requireTechnician = async (db, accountId) => {
    const account = await db.account.findUnique({ where: { id: accountId }, select: { role: true, status: true } });
    if (account?.role !== ACCOUNT_ROLE.TECHNICIAN || account.status !== ACCOUNT_STATUS.ACTIVE) {
        throw ApiError.forbidden(MESSAGES.FORBIDDEN);
    }
};
const requireSeason = async (db, accountId, seasonId, writing = false) => {
    if (!seasonId) throw ApiError.forbidden(MESSAGES.SEASON_REQUIRED);
    const assignment = await db.seasonPersonnelAssignment.findFirst({
        where: { accountId, seasonId, role: PERSONNEL_ROLE.TECHNICIAN, unassignedAt: null,
            season: { pond: { isDeleted: false, farm: { isDeleted: false } } } },
        select: { season: { select: { id: true, name: true, status: true } } },
    });
    if (!assignment) throw ApiError.forbidden(MESSAGES.ASSIGNMENT_REQUIRED);
    if (writing && [SEASON_STATUS.COMPLETED, SEASON_STATUS.CANCELLED].includes(assignment.season.status)) {
        throw ApiError.forbidden(MESSAGES.SEASON_CLOSED);
    }
    return assignment.season;
};
const requireConversation = async (db, accountId, id, writing = false) => {
    const conversation = await db.ragConversation.findFirst({ where: { id, accountId } });
    if (!conversation) throw ApiError.notFound(MESSAGES.NOT_FOUND);
    const season = await requireSeason(db, accountId, conversation.seasonId, writing);
    return { ...conversation, season };
};
const normalizeQuery = (query) => ({
    ...query, topSimilarity: query.topSimilarity == null ? null : Number(query.topSimilarity),
    warning: WARNINGS[query.queryStatus] || null,
});
const atomic = async (work) => {
    try {
        return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
    } catch (error) {
        if (error.code === 'P2034' || error.code === 'P2002') throw ApiError.conflict(MESSAGES.CONFLICT);
        throw error;
    }
};
const askQuestion = async (accountId, input) => {
    await requireTechnician(prisma, accountId);
    let seasonId = input.seasonId;
    if (input.conversationId) {
        const conversation = await requireConversation(prisma, accountId, input.conversationId, true);
        if (seasonId && seasonId !== conversation.seasonId) throw ApiError.badRequest(MESSAGES.SEASON_MISMATCH);
        seasonId = conversation.seasonId;
    } else {
        await requireSeason(prisma, accountId, seasonId, true);
    }
    const conversationId = input.conversationId || randomUUID();
    // Keep slow external generation outside database transactions; recheck permissions at commit.
    const result = await ragClient.ask({ ...input, accountId, conversationId, seasonId });
    return atomic(async (db) => {
        await requireTechnician(db, accountId);
        if (input.conversationId) await requireConversation(db, accountId, conversationId, true);
        else {
            await requireSeason(db, accountId, seasonId, true);
            await db.ragConversation.create({ data: { id: conversationId, accountId, seasonId, title: Array.from(input.question).slice(0, 255).join('') } });
        }
        const query = await db.ragQuery.create({ data: { ...result, conversationId, accountId, question: input.question }, include: { feedback: true } });
        await db.ragConversation.update({ where: { id: conversationId }, data: { lastMessageAt: query.createdAt } });
        return normalizeQuery(query);
    });
};
const metaFor = (page, limit, totalResults) => ({ page, limit, totalResults, totalPages: Math.ceil(totalResults / limit), hasNextPage: page * limit < totalResults });
const listConversations = async (accountId, { seasonId, page = 1, limit = 20 }) => atomic(async (db) => {
    await requireTechnician(db, accountId);
    await requireSeason(db, accountId, seasonId);
    const where = { accountId, seasonId };
    const rows = await db.ragConversation.findMany({
        where, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { queries: { select: { question: true, answer: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
    });
    const total = await db.ragConversation.count({ where });
    const counts = rows.length ? await db.ragQuery.groupBy({
        by: ['conversationId'], where: { accountId, conversationId: { in: rows.map((row) => row.id) } },
        _count: { id: true, answer: true },
    }) : [];
    const messageCounts = new Map(counts.map((row) => [row.conversationId, row._count.id + row._count.answer]));
    const conversations = rows.map(({ queries, ...row }) => ({
        ...row, lastMessagePreview: (queries[0]?.answer || queries[0]?.question || '').slice(0, 200),
        messageCount: messageCounts.get(row.id) || 0,
    }));
    return { conversations, meta: metaFor(page, limit, total) };
});
const getConversation = async (accountId, id, { page = 1, limit = 20 } = {}) => atomic(async (db) => {
    await requireTechnician(db, accountId);
    const conversation = await requireConversation(db, accountId, id);
    const where = { conversationId: id, accountId };
    const queries = await db.ragQuery.findMany({ where, include: { feedback: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit });
    const total = await db.ragQuery.count({ where });
    return { conversation: { ...conversation, canAsk: ![SEASON_STATUS.COMPLETED, SEASON_STATUS.CANCELLED].includes(conversation.season.status), queries: queries.map(normalizeQuery) }, meta: metaFor(page, limit, total) };
});
const saveFeedback = async (accountId, queryId, { rating, comment }) => atomic(async (db) => {
    await requireTechnician(db, accountId);
    const query = await db.ragQuery.findFirst({ where: { id: queryId, accountId } });
    if (!query) throw ApiError.notFound(MESSAGES.QUERY_NOT_FOUND);
    await requireConversation(db, accountId, query.conversationId);
    if (query.queryStatus === STATUS.ERROR || !query.answer?.trim()) throw ApiError.conflict(MESSAGES.NO_ANSWER);
    const data = { rating, comment: comment?.trim() || null };
    // Native upsert uses the existing UNIQUE(query_id), including simultaneous first feedbacks.
    return db.ragFeedback.upsert({ where: { queryId }, create: { queryId, evaluatorId: accountId, ...data }, update: data });
});
module.exports = { askQuestion, listConversations, getConversation, saveFeedback };
