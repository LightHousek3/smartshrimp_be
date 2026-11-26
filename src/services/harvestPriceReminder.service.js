/** Find overdue unpriced harvests and persist the Owner reminder once per harvest. */
const prisma = require('../config/prisma');
const logger = require('../config/logger');
const jobTransaction = require('../utils/jobTransaction');
const notices = require('../utils/jobNotification');
const { errorDetail } = require('../utils/productionSchedule');
const { messages, NOTIFICATION_TYPE } = require('../constants');

const PAGE_SIZE = 100;
const WAIT_MS = 72 * 60 * 60 * 1000;
const REFERENCE_TYPE = 'harvest_event';

const remindHarvest = async (id, cutoff, now) => {
    const notice = await jobTransaction(async (tx) => {
        // The price update and the deadline check share the harvest row lock.
        const [row] = await tx.$queryRaw`SELECT f.owner_id AS "ownerId", s.name AS "seasonName"
            FROM harvest_events h JOIN aquaculture_seasons s ON s.id = h.season_id
            JOIN ponds p ON p.id = s.pond_id JOIN farms f ON f.id = p.farm_id
            JOIN accounts a ON a.id = f.owner_id
            WHERE h.id = ${id}::uuid AND h.price_per_kg IS NULL AND h.created_at <= ${cutoff}
                AND a.status = 'active' AND a.role = 'farm_owner'
            FOR UPDATE OF h`;
        if (!row) return null;
        return notices.save(tx, ['harvest-price', id], {
            accountId: row.ownerId,
            type: NOTIFICATION_TYPE.SYSTEM,
            referenceType: REFERENCE_TYPE,
            referenceId: id,
            title: messages.HARVEST.PRICE_REMINDER_TITLE,
            content: messages.HARVEST.PRICE_REMINDER_CONTENT(row.seasonName),
            createdAt: now,
        });
    });
    notices.deliver([notice]);
    return Boolean(notice);
};

/** Sweep overdue prices in bounded batches, including harvests from completed seasons. */
const remind = async ({ now = new Date(), isRunning = () => true } = {}) => {
    const cutoff = new Date(now.getTime() - WAIT_MS);
    let cursor = null;
    let rows;
    let sent = 0;
    let failed = 0;
    do {
        rows = await prisma.$queryRaw`SELECT h.id FROM harvest_events h
            JOIN aquaculture_seasons s ON s.id = h.season_id
            JOIN ponds p ON p.id = s.pond_id JOIN farms f ON f.id = p.farm_id
            JOIN accounts a ON a.id = f.owner_id
            WHERE h.price_per_kg IS NULL AND h.created_at <= ${cutoff}
                AND (${cursor}::uuid IS NULL OR h.id > ${cursor}::uuid)
                AND a.status = 'active' AND a.role = 'farm_owner'
                AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.account_id = f.owner_id
                    AND n.type = 'system' AND n.reference_type = ${REFERENCE_TYPE} AND n.reference_id = h.id)
            ORDER BY h.id LIMIT ${PAGE_SIZE}`;
        for (const { id } of rows) {
            if (!isRunning()) return { sent, failed };
            try {
                if (await remindHarvest(id, cutoff, now)) sent++;
            } catch (error) {
                failed++;
                logger.error(`Harvest ${id} price reminder failed: ${errorDetail(error)}`);
            }
            cursor = id;
        }
    } while (isRunning() && rows.length === PAGE_SIZE);
    return { sent, failed };
};

module.exports = { remind };
