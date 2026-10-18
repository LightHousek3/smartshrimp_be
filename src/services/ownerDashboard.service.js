const {
    Prisma,
    FarmStatus: FARM_STATUS,
} = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    SEASON_STATUS,
    ALERT_KIND,
    DASHBOARD_PERIOD,
    PRODUCT_UNIT,
} = require('../constants');

const DAY_MS = 86400000;
const MAX_FINANCE_MONTHS = 60;
const PACKAGED_UNITS = new Set([PRODUCT_UNIT.PACK, PRODUCT_UNIT.BOTTLE]);
const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});
const seasonContextSelect = {
    id: true,
    name: true,
    pond: { select: { id: true, name: true, farm: { select: { id: true, name: true } } } },
};

/**
 * Only operating farms contribute planning/active seasons to actionable work.
 */
const visibleSeason = (ownerId) => ({
    status: { in: [SEASON_STATUS.PLANNING, SEASON_STATUS.ACTIVE] },
    pond: { farm: { ownerId, status: FARM_STATUS.ACTIVE } },
});

/** Build a stable Vietnam calendar date, independent of the server's local timezone. */
const todayInVietnam = (now) => {
    const parts = Object.fromEntries(
        localDate.formatToParts(now).map(({ type, value }) => [type, value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
};

/** Only display/navigation fields leave the service; no account or protocol internals. */
const contextForSeason = (season, { includePondName = true } = {}) => ({
    seasonId: season.id,
    seasonName: season.name,
    pondId: season.pond.id,
    ...(includePondName && { pondName: season.pond.name }),
    farmId: season.pond.farm.id,
    farmName: season.pond.farm.name,
});

/** Fetch a count and one deterministic preview without loading every alert. */
const alertPreview = async (delegate, where, select, kind, normalize, dateField = 'createdAt') => {
    const [count, items] = await Promise.all([
        delegate.count({ where }),
        delegate.findMany({
            where,
            select,
            orderBy: [{ [dateField]: 'desc' }, { id: 'desc' }],
            take: 1,
        }),
    ]);
    return count === 0 ? null : { kind, count, preview: normalize(items[0]) };
};

/** Compute lot-valued inventory using Decimal so lots and alert thresholds do not drift. */
const inventorySummary = (farms, products) => {
    const inventories = farms.map((farm) => ({
        farmId: farm.id,
        farmName: farm.name,
        productCount: 0,
        lowStockCount: 0,
        stockValue: new Prisma.Decimal(0),
    }));
    const byFarm = new Map(inventories.map((item) => [item.farmId, item]));
    const lowStockByFarm = new Map();
    for (const product of products) {
        const inventory = byFarm.get(product.farmId);
        const quantity = product.inventoryBalances.reduce(
            (sum, lot) => sum.plus(lot.quantity),
            new Prisma.Decimal(0),
        );
        inventory.productCount += 1;
        inventory.stockValue = product.inventoryBalances.reduce(
            (sum, lot) => sum.plus(new Prisma.Decimal(lot.quantity).times(lot.unitPrice)),
            inventory.stockValue,
        );
        // Warehouse thresholds for bottles/packs use the conversion unit, while
        // balances and stock valuation retain their original stock unit.
        const usesConversion = PACKAGED_UNITS.has(product.unit)
            && product.conversionUnit && new Prisma.Decimal(product.conversionQuantity ?? 0).gt(0);
        const alertQuantity = usesConversion ? quantity.times(product.conversionQuantity) : quantity;
        const threshold = new Prisma.Decimal(product.minAlertQuantity);
        // A disabled threshold or stock exactly at the minimum is not low.
        if (threshold.gt(0) && alertQuantity.lessThan(threshold)) {
            inventory.lowStockCount += 1;
            const preview = {
                id: product.id,
                title: product.name,
                farmId: product.farmId,
                farmName: inventory.farmName,
                quantity: Number(alertQuantity),
                minAlertQuantity: Number(product.minAlertQuantity),
                unit: usesConversion ? product.conversionUnit : product.unit,
            };
            // Collect every low product in the same scope as the count and warehouse link.
            const farmAlert = lowStockByFarm.get(product.farmId);
            if (farmAlert) {
                farmAlert.productNames.push(product.name);
            } else {
                lowStockByFarm.set(product.farmId, { preview, productNames: [product.name] });
            }
        }
    }
    return {
        inventories: inventories.map((item) => ({
            ...item,
            stockValue: Number(item.stockValue.toFixed(2)),
        })),
        lowStockAlerts: inventories.filter((item) => item.lowStockCount > 0).map((item) => {
            const { preview, productNames } = lowStockByFarm.get(item.farmId);
            return {
                kind: ALERT_KIND.LOW_STOCK,
                count: item.lowStockCount,
                // Send complete names; only the presentation layer truncates the caption.
                preview: { ...preview, title: productNames.join(', ') },
            };
        }),
    };
};

/**
 * Read the owner's operational overview in one consistent snapshot, including farm and pond
 * totals, active seasons, alerts, inventory, and personnel counts.
 * Every alert and inventory preview carries its owned farm ID for scoped App navigation.
 * RepeatableRead keeps alert counts and their preview records in the same snapshot.
 * @param {string} ownerId Authenticated farm owner's account ID.
 * @param {Date} [now=new Date()] Reference time used for the Vietnam-local date and season day.
 * @returns {Promise<Object>} Operational overview data for the owner dashboard.
 */
const getOverview = async (ownerId, now = new Date()) =>
    prisma.$transaction(
        async (tx) => {
            const [farms, financeFarms, seasons, personnel] = await Promise.all([
                tx.farm.findMany({
                    where: { ownerId, status: FARM_STATUS.ACTIVE },
                    select: {
                        id: true,
                        name: true,
                        _count: {
                            select: {
                                ponds: {
                                    where: {
                                        type: 'AQUACULTURE',
                                    },
                                },
                            },
                        },
                    },
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                }),
                // Inactive farms remain selectable for their retained financial history.
                tx.farm.findMany({
                    where: { ownerId },
                    select: { id: true, name: true },
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                }),
                tx.aquacultureSeason.findMany({
                    where: visibleSeason(ownerId),
                    select: {
                        ...seasonContextSelect,
                        status: true,
                        stockingDate: true,
                        shrimpType: true,
                    },
                    orderBy: [{ stockingDate: 'asc' }, { id: 'asc' }],
                }),
                tx.account.groupBy({
                    by: ['role', 'status'],
                    where: {
                        managedByOwnerId: ownerId,
                        role: { in: [ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT] },
                    },
                    _count: { _all: true },
                }),
            ]);
            const farmIds = farms.map(({ id }) => id);
            const seasonIds = seasons.map(({ id }) => id);
            const seasonById = new Map(seasons.map((season) => [season.id, season]));
            const farmById = new Map(farms.map((farm) => [farm.id, farm]));
            const caseWhere = { season: visibleSeason(ownerId) };
            const protocolWhere = { season: visibleSeason(ownerId), status: 'PENDING_APPROVAL' };
            const normalize = (item) => ({
                id: item.id,
                title: item.title,
                // Protocol/case captions use farm and season; pondId still supports navigation.
                ...contextForSeason(item.season, { includePondName: false }),
            });
            const [products, ...alerts] = await Promise.all([
                tx.product.findMany({
                    // Use the warehouse's current catalog, not the legacy product status.
                    where: { farmId: { in: farmIds }, archivedAt: null, isDeleted: false },
                    select: {
                        id: true,
                        name: true,
                        farmId: true,
                        unit: true,
                        minAlertQuantity: true,
                        conversionQuantity: true,
                        conversionUnit: true,
                        inventoryBalances: {
                            where: { quantity: { gt: 0 } },
                            select: { quantity: true, unitPrice: true },
                        },
                    },
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                }),
                // Existing task statuses determine actionable work, without soft-delete columns.
                alertPreview(
                    tx.task,
                    {
                        farmId: { in: farmIds },
                        priority: 'URGENT',
                        status: { in: ['PENDING', 'IN_PROGRESS'] },
                        OR: [{ seasonId: null }, { seasonId: { in: seasonIds } }],
                    },
                    { id: true, title: true, farmId: true, seasonId: true },
                    ALERT_KIND.URGENT_TASK,
                    (item) => ({
                        id: item.id,
                        title: item.title,
                        farmId: item.farmId,
                        farmName: farmById.get(item.farmId).name,
                        ...(item.seasonId && contextForSeason(seasonById.get(item.seasonId))),
                    }),
                ),
                alertPreview(
                    tx.protocol,
                    { ...protocolWhere, protocolType: 'TREATMENT' },
                    {
                        id: true,
                        title: true,
                        season: { select: seasonContextSelect },
                    },
                    ALERT_KIND.PENDING_TREATMENT,
                    normalize,
                ),
                alertPreview(
                    tx.protocol,
                    { ...protocolWhere, protocolType: 'PRODUCTION' },
                    {
                        id: true,
                        title: true,
                        season: { select: seasonContextSelect },
                    },
                    ALERT_KIND.PENDING_PRODUCTION,
                    normalize,
                ),
                alertPreview(
                    tx.diseaseCase,
                    { ...caseWhere, status: 'IN_TREATMENT' },
                    {
                        id: true,
                        title: true,
                        season: { select: seasonContextSelect },
                    },
                    ALERT_KIND.IN_TREATMENT,
                    normalize,
                    'updatedAt',
                ),
                alertPreview(
                    tx.diseaseCase,
                    { ...caseWhere, status: { in: ['OPEN', 'WAITING_FOR_INFO', 'MONITORING'] } },
                    {
                        id: true,
                        title: true,
                        season: { select: seasonContextSelect },
                    },
                    ALERT_KIND.MONITORING,
                    normalize,
                    'updatedAt',
                ),
            ]);
            const { inventories, lowStockAlerts } = inventorySummary(farms, products);
            alerts.splice(3, 0, ...lowStockAlerts);
            const activeSeasons = seasons.filter(({ status }) => status === SEASON_STATUS.ACTIVE);
            const today = new Date(`${todayInVietnam(now)}T00:00:00Z`);
            return {
                date: todayInVietnam(now),
                financeFarms: financeFarms.map(({ id, name }) => ({ id, name })),
                summary: {
                    farms: farms.length,
                    ponds: farms.reduce((sum, farm) => sum + farm._count.ponds, 0),
                    activeSeasons: activeSeasons.length,
                },
                alerts: alerts.filter(Boolean),
                seasons: activeSeasons.map((season) => ({
                    ...contextForSeason(season),
                    shrimpType: season.shrimpType,
                    dayOfCulture:
                        season.stockingDate && season.stockingDate <= today
                            ? Math.floor((today - season.stockingDate) / DAY_MS) + 1
                            : null,
                })),
                inventories,
                personnel: {
                    technicians: personnel
                        .filter(({ role }) => role === ACCOUNT_ROLE.TECHNICIAN)
                        .reduce((sum, row) => sum + row._count._all, 0),
                    experts: personnel
                        .filter(({ role }) => role === ACCOUNT_ROLE.EXPERT)
                        .reduce((sum, row) => sum + row._count._all, 0),
                    active: personnel
                        .filter(({ status }) => status === ACCOUNT_STATUS.ACTIVE)
                        .reduce((sum, row) => sum + row._count._all, 0),
                },
            };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

/** Resolve inclusive calendar dates; SQL uses the next day's midnight as the exclusive end. */
const financeRange = ({ period = DASHBOARD_PERIOD.THIS_MONTH, from, to }, now) => {
    const today = todayInVietnam(now);
    const [year, month] = today.split('-').map(Number);
    let start;
    let end = today;
    if (period === DASHBOARD_PERIOD.CUSTOM) {
        start = from;
        end = to;
    } else if (period === DASHBOARD_PERIOD.LAST_MONTH) {
        start = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
        end = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
    } else {
        const months =
            period === DASHBOARD_PERIOD.YEAR ? 12 : period === DASHBOARD_PERIOD.SIX_MONTHS ? 6 : 1;
        start = new Date(Date.UTC(year, month - months, 1)).toISOString().slice(0, 10);
    }
    const monthCount =
        (Number(end?.slice(0, 4)) - Number(start?.slice(0, 4))) * 12 +
        Number(end?.slice(5, 7)) -
        Number(start?.slice(5, 7)) +
        1;
    if (!start || !end || start > end || end > today || monthCount > MAX_FINANCE_MONTHS) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.OWNER_DASHBOARD.INVALID_RANGE);
    }
    return { from: start, to: end };
};

/**
 * Aggregate retained financial facts, never purchases or unrecorded operational costs.
 * Lifecycle/status changes must not erase historical income or crop stock-out cost.
 * Parameterized SQL is needed because Prisma has no calendar-month/timezone groupBy and
 * harvest_events already exists in smartshrimp.sql but has no Prisma model. No DB change.
 * @param {string} ownerId Authenticated farm owner's account ID.
 * @param {Object} query Validated farm and period filters.
 * @param {Date} [now=new Date()] Reference time used to resolve relative calendar periods.
 * @returns {Promise<Object>} Monthly income/cost rows and totals for the selected date range.
 */
const getFinance = async (ownerId, query, now = new Date()) => {
    const range = financeRange(query, now);
    if (query.farmId) {
        const farm = await prisma.farm.findFirst({
            where: { id: query.farmId, ownerId },
            select: { id: true },
        });
        if (!farm) throw new ApiError(httpStatus.NOT_FOUND, messages.FARM.NOT_FOUND);
    }
    const farmFilter = query.farmId ? Prisma.sql`AND f.id = ${query.farmId}::uuid` : Prisma.empty;
    const rows = await prisma.$queryRaw(Prisma.sql`
        WITH bounds AS (
            SELECT ${range.from}::date AS from_date, ${range.to}::date AS to_date
        ), facts AS (
            SELECT date_trunc('month', h.harvested_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS month,
                   coalesce(h.total_revenue, 0) AS income, 0::numeric AS cost
            FROM harvest_events h
            JOIN aquaculture_seasons s ON s.id = h.season_id
            JOIN ponds p ON p.id = s.pond_id
            JOIN farms f ON f.id = p.farm_id CROSS JOIN bounds b
            WHERE f.owner_id = ${ownerId}::uuid ${farmFilter}
              AND h.harvested_at >= b.from_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
              AND h.harvested_at < (b.to_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
            UNION ALL
            SELECT date_trunc('month', t.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'),
                   0::numeric, t.total_amount
            FROM inventory_transactions t
            JOIN products pr ON pr.id = t.product_id
            JOIN aquaculture_seasons s ON s.id = t.season_id
            JOIN ponds p ON p.id = s.pond_id
            JOIN farms f ON f.id = p.farm_id CROSS JOIN bounds b
            WHERE f.owner_id = ${ownerId}::uuid ${farmFilter}
              AND pr.farm_id = f.id AND t.transaction_type = 'stock_out'
              AND pr.category IN ('feed', 'medicine', 'mineral', 'chemical')
              AND t.created_at >= b.from_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
              AND t.created_at < (b.to_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        )
        SELECT to_char(m.month, 'YYYY-MM') AS month,
               coalesce(sum(facts.income), 0) AS income, coalesce(sum(facts.cost), 0) AS cost
        FROM bounds b CROSS JOIN LATERAL generate_series(
            date_trunc('month', b.from_date::timestamp), date_trunc('month', b.to_date::timestamp), interval '1 month'
        ) m(month)
        LEFT JOIN facts ON facts.month = m.month
        GROUP BY m.month ORDER BY m.month
    `);
    const income = rows.reduce((sum, row) => sum.plus(row.income), new Prisma.Decimal(0));
    const cost = rows.reduce((sum, row) => sum.plus(row.cost), new Prisma.Decimal(0));
    return {
        ...range,
        months: rows.map((row) => ({
            month: row.month,
            income: Number(row.income),
            cost: Number(row.cost),
        })),
        totals: { income: Number(income), cost: Number(cost), profit: Number(income.minus(cost)) },
    };
};

module.exports = { getOverview, getFinance };
