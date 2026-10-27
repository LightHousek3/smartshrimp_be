const prisma = require('../config/prisma');

/**
 * Keep ledger filter choices complete without downloading every transaction.
 */
const getHistoryOptions = async (farmId) => {
    const [products, seasons] = await Promise.all([
        prisma.$queryRaw`SELECT DISTINCT p.id,p.name,p.category::text AS category,p.unit::text AS unit
            FROM inventory_transactions t JOIN products p ON p.id=t.product_id
            WHERE p.farm_id=${farmId}::uuid ORDER BY p.name,p.id`,
        prisma.$queryRaw`SELECT DISTINCT s.id,s.name,pond.name AS "pondName"
            FROM inventory_transactions t JOIN products p ON p.id=t.product_id
            JOIN aquaculture_seasons s ON s.id=t.season_id JOIN ponds pond ON pond.id=s.pond_id
            WHERE p.farm_id=${farmId}::uuid ORDER BY s.name,s.id`,
    ]);
    return {
        products: products.map((p) => ({
            ...p,
            category: p.category.toUpperCase(),
            unit: p.unit.toUpperCase(),
        })),
        seasons,
    };
};

module.exports = { getHistoryOptions };
