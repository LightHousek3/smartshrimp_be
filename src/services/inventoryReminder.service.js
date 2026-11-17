const prisma = require('../config/prisma');
const jobTransaction = require('../utils/jobTransaction');
const logger = require('../config/logger');
const notices = require('../utils/jobNotification');
const { vietnamDate } = require('../utils/inventoryQuantity');
const { errorDetail } = require('../utils/productionSchedule');
const { notifyStockChange } = require('./inventory.service');

/** Group receipt layers by the manufacturer's lot, independently of their supplier and unit cost. */
const remindProduct = async (productId, now = new Date()) => {
    const notifications = [];
    const result = await jobTransaction(async (tx) => {
        notifications.length = 0;
        await tx.$queryRaw`SELECT id FROM products WHERE id=${productId}::uuid FOR UPDATE`;
        const product = await tx.product.findFirst({
            where: { id: productId, farm: { status: 'ACTIVE', owner: { status: 'ACTIVE' } } },
            include: {
                farm: { select: { ownerId: true } },
                inventoryBalances: { where: { quantity: { gt: 0 }, receivedAt: { lte: now } } },
            },
        });
        if (!product) return 0;
        notifications.push(...(await notifyStockChange(tx, product, { at: now })));
        const groups = new Map();
        const today = vietnamDate(now);
        for (const balance of product.inventoryBalances) {
            // Legacy unknown expiry remains unusable and belongs to preflight data correction.
            if (!balance.expiryDate) continue;
            const remainingDays = (balance.expiryDate - today) / 86400000;
            const stage = remainingDays <= 0 ? 'END' : remainingDays <= 7 ? 'EXPIRING' : null;
            if (!stage) continue;
            const lot = balance.lotNumber.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');
            const date = balance.expiryDate?.toISOString().slice(0, 10) ?? 'unknown';
            const key = JSON.stringify([lot, date, stage]);
            if (!groups.has(key)) groups.set(key, { lot, date, stage, remainingDays });
        }
        for (const { lot, date, stage, remainingDays } of groups.values()) {
            const state =
                remainingDays < 0
                    ? `đã hết hạn ${date}, không được dùng vận hành`
                    : remainingDays === 0
                      ? `hết hạn hôm nay ${date}, chỉ còn dùng được đến hết ngày Việt Nam này`
                      : `có hạn dùng ${date}, cần kiểm tra kế hoạch sử dụng`;
            const saved = await notices.save(tx, ['inventory-lot', productId, lot, date, stage], {
                accountId: product.farm.ownerId,
                type: 'SYSTEM',
                referenceType: 'product',
                referenceId: productId,
                title:
                    remainingDays < 0
                        ? 'Lô vật tư đã hết hạn'
                        : remainingDays === 0
                          ? 'Lô vật tư hết hạn hôm nay'
                          : 'Lô vật tư sắp hết hạn',
                content: `${product.name}, lô ${lot}: ${state}. Tồn sổ được giữ nguyên; chủ trại quyết định sử dụng, trả hàng hoặc tiêu hủy theo nghiệp vụ kho.`,
                createdAt: now,
            });
            if (saved) notifications.push(saved);
        }
        return notifications.length;
    });
    notices.deliver(notifications);
    return result;
};

const remind = async ({ now = new Date(), isRunning = () => true } = {}) => {
    let cursor,
        rows,
        processed = 0,
        failed = 0;
    do {
        rows = await prisma.product.findMany({
            where: { farm: { status: 'ACTIVE' }, ...(cursor && { id: { gt: cursor } }) },
            select: { id: true },
            take: 100,
            orderBy: { id: 'asc' },
        });
        for (const row of rows) {
            if (!isRunning()) break;
            try {
                await remindProduct(row.id, now);
                processed++;
            } catch (error) {
                failed++;
                logger.error(`Product ${row.id} inventory reminder failed: ${errorDetail(error)}`);
            }
            cursor = row.id;
        }
    } while (isRunning() && rows.length === 100);
    return { processed, failed };
};

module.exports = { remind, remindProduct };
