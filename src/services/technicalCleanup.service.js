const jobTransaction = require('../utils/jobTransaction');

const DAY_MS = 86400000;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;
/**
 * Include absent retention timestamps alongside values at or before the cleanup cutoff.
 */
const oldOrEmpty = (field, cutoff) => ({ OR: [{ [field]: null }, { [field]: { lte: cutoff } }] });

/** Retain every live deadline and recent terminal event, rather than deleting by creation time alone. */
const candidates = (cutoff) => ({
    refreshToken: {
        expiresAt: { lte: cutoff },
        createdAt: { lte: cutoff },
        AND: [oldOrEmpty('revokedAt', cutoff)],
    },
    emailVerificationChallenge: {
        expiresAt: { lte: cutoff },
        resendAvailableAt: { lte: cutoff },
        createdAt: { lte: cutoff },
        AND: ['actionTokenExpiresAt', 'verifiedAt', 'consumedAt', 'supersededAt'].map((field) =>
            oldOrEmpty(field, cutoff),
        ),
    },
});

/** Delete bounded batches with the original predicate rechecked inside the same transaction. */
const cleanup = async ({ now = new Date(), isRunning = () => true } = {}) => {
    const cutoff = new Date(now.getTime() - 30 * DAY_MS);
    const counts = { refreshToken: 0, emailVerificationChallenge: 0 };
    let unfinished = false;
    for (const [model, where] of Object.entries(candidates(cutoff))) {
        for (let batch = 0; batch < MAX_BATCHES && isRunning(); batch++) {
            const result = await jobTransaction(async (tx) => {
                const rows = await tx[model].findMany({
                    where,
                    select: { id: true },
                    orderBy: { id: 'asc' },
                    take: BATCH_SIZE,
                });
                const removed = rows.length
                    ? await tx[model].deleteMany({
                          where: { ...where, id: { in: rows.map((row) => row.id) } },
                      })
                    : { count: 0 };
                return { selected: rows.length, removed: removed.count };
            });
            counts[model] += result.removed;
            if (result.selected < BATCH_SIZE) break;
            if (batch === MAX_BATCHES - 1) unfinished = true;
        }
    }
    return { ...counts, nextCheckAt: unfinished ? Date.now() + 60000 : null };
};

module.exports = { cleanup };
