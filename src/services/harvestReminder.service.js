const prisma = require('../config/prisma');
const jobTransaction = require('../utils/jobTransaction');
const logger = require('../config/logger');
const notices = require('../utils/jobNotification');
const { dateInVietnam, errorDetail } = require('../utils/productionSchedule');
const { readWithdrawal } = require('./harvestWithdrawal.service');

/** Notify the current planning phase only; neither the planned end date nor a notice permits a harvest. */
const remindSeason = async (seasonId, now = new Date()) => {
    const saved = await jobTransaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${seasonId}::uuid FOR UPDATE`;
        const season = await tx.aquacultureSeason.findFirst({
            where: {
                id: seasonId,
                status: 'ACTIVE',
                expectedEndDate: { not: null },
                pond: {
                    farm: { status: 'ACTIVE', owner: { status: 'ACTIVE', role: 'FARM_OWNER' } },
                },
            },
            include: { pond: { select: { farm: { select: { ownerId: true } } } } },
        });
        if (!season) return null;
        const date = season.expectedEndDate.toISOString().slice(0, 10);
        const days = (Date.parse(date) - Date.parse(dateInVietnam(now))) / 86400000;
        if (days > 3) return null;
        const stage = days < 0 ? 'OVERDUE' : days === 0 ? 'TODAY' : 'UPCOMING';
        const state = await readWithdrawal(tx, seasonId, now);
        const protection = state.unknown
            ? 'Chưa đủ căn cứ xác nhận thời gian ngừng vật tư.'
            : state.blocked
              ? `Còn thời gian ngừng vật tư tới ${state.latestEndAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`
              : 'Cần kiểm tra tình trạng đàn và các điều kiện thực tế trước khi thu.';
        return notices.save(tx, ['harvest-plan', seasonId, date, stage], {
            accountId: season.pond.farm.ownerId,
            type: 'HARVEST_DUE',
            referenceType: 'aquaculture_season',
            referenceId: seasonId,
            title:
                stage === 'OVERDUE'
                    ? 'Vụ nuôi đã qua ngày kết thúc dự kiến'
                    : stage === 'TODAY'
                      ? 'Hôm nay là ngày kết thúc vụ dự kiến'
                      : 'Sắp tới ngày kết thúc vụ dự kiến',
            content: `${season.name}: kế hoạch ngày ${date}. ${protection} Thông báo này không xác nhận được phép thu hoạch.`,
            createdAt: now,
        });
    });
    notices.deliver([saved]);
    return Boolean(saved);
};

/**
 * Sweep active seasons with expected end dates in bounded batches and isolate failures by season.
 */
const remind = async ({ now = new Date(), isRunning = () => true } = {}) => {
    let cursor,
        rows,
        processed = 0,
        failed = 0;
    do {
        rows = await prisma.aquacultureSeason.findMany({
            where: {
                status: 'ACTIVE',
                expectedEndDate: { not: null },
                pond: { farm: { status: 'ACTIVE' } },
                ...(cursor && { id: { gt: cursor } }),
            },
            select: { id: true },
            take: 100,
            orderBy: { id: 'asc' },
        });
        for (const row of rows) {
            if (!isRunning()) break;
            try {
                await remindSeason(row.id, now);
                processed++;
            } catch (error) {
                failed++;
                logger.error(`Season ${row.id} harvest reminder failed: ${errorDetail(error)}`);
            }
            cursor = row.id;
        }
    } while (isRunning() && rows.length === 100);
    return { processed, failed };
};

module.exports = { remind, remindSeason };
