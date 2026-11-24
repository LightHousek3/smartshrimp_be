const prisma = require('../config/prisma');
const logger = require('../config/logger');
const jobTransaction = require('../utils/jobTransaction');
const notices = require('../utils/jobNotification');
const { dateInVietnam, errorDetail } = require('../utils/productionSchedule');

const STOCKING_REMINDER_HOUR = '05';
const eligible = (date) => ({
    status: 'PLANNING',
    plannedStockingDate: new Date(`${date}T00:00:00Z`),
    pond: {
        status: 'AVAILABLE',
        type: 'AQUACULTURE',
        farm: { status: 'ACTIVE', owner: { status: 'ACTIVE', role: 'FARM_OWNER' } },
    },
});

const remindSeason = async (seasonId, date, now) => {
    const saved = await jobTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${seasonId}::uuid FOR UPDATE`;
        const season = await tx.aquacultureSeason.findFirst({
            where: { id: seasonId, ...eligible(date) },
            select: { name: true, pond: { select: { farm: { select: { ownerId: true } } } } },
        });
        if (!season) return null;
        return notices.save(tx, ['stocking-plan', seasonId, date], {
            accountId: season.pond.farm.ownerId,
            type: 'SYSTEM',
            referenceType: 'aquaculture_season',
            referenceId: seasonId,
            title: 'Hôm nay là ngày thả giống dự kiến',
            content: `${season.name}: nếu đã thả giống, hãy xác nhận ngày thả thực tế tại mục Kích hoạt vụ nuôi.`,
            createdAt: now,
        });
    });
    notices.deliver([saved]);
    return Boolean(saved);
};

/** Catch up on the same Vietnam date after a restart, without replaying earlier plans. */
const remind = async ({ now = new Date(), isRunning = () => true } = {}) => {
    const date = dateInVietnam(now);
    if (now < new Date(`${date}T${STOCKING_REMINDER_HOUR}:00:00+07:00`))
        return { notified: 0, failed: 0 };
    let cursor;
    let notified = 0;
    let failed = 0;
    while (isRunning()) {
        const rows = await prisma.aquacultureSeason.findMany({
            where: { ...eligible(date), ...(cursor && { id: { gt: cursor } }) },
            select: { id: true },
            take: 100,
            orderBy: { id: 'asc' },
        });
        for (const { id } of rows) {
            if (!isRunning()) break;
            try {
                if (await remindSeason(id, date, now)) notified++;
            } catch (error) {
                failed++;
                logger.error(`Season ${id} stocking reminder failed: ${errorDetail(error)}`);
            }
            cursor = id;
        }
        if (rows.length < 100) break;
    }
    return { notified, failed };
};

module.exports = { remind, STOCKING_REMINDER_HOUR };
