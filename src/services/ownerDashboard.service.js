const {
    Prisma,
} = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const {
    httpStatus,
    messages,
    ACCOUNT_ROLE,
    ACCOUNT_STATUS,
    FARM_STATUS,
    SEASON_STATUS,
    ALERT_KIND,
    DASHBOARD_PERIOD,
    DISEASE_CASE_STATUS,
} = require('../constants');
const { usableStock, stockInAlertUnit, alertUnit } = require('../utils/inventoryStock');

const DAY_MS = 86400000;
const MAX_FINANCE_MONTHS = 60;
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

/**
 * Each unresolved episode has its own season and detail target (BR-88/90).
 * Legacy WAITING_FOR_INFO is an open conversation, never post-treatment monitoring.
 */
const diseaseAlerts = (cases) => cases.map((item) => ({
    kind: item.status === DISEASE_CASE_STATUS.IN_TREATMENT
        ? ALERT_KIND.IN_TREATMENT
        : item.status === DISEASE_CASE_STATUS.MONITORING ? ALERT_KIND.MONITORING : ALERT_KIND.CASE_OPEN,
    count: 1,
    preview: { id: item.id, title: item.title, ...contextForSeason(item.season, { includePondName: false }) },
}));

/** Group all actionable urgent titles by farm/pond/season; retain the newest task as the detail target. */
const urgentTaskAlerts = (tasks, farmById) => {
    const groups = new Map();
    for (const task of tasks) {
        const key = JSON.stringify([task.farmId, task.seasonId]);
        const group = groups.get(key);
        if (group) {
            group.count += 1;
            group.titles.push(task.title);
        } else {
            groups.set(key, {
                count: 1,
                titles: [task.title],
                preview: {
                    id: task.id,
                    farmId: task.farmId,
                    farmName: farmById.get(task.farmId).name,
                    ...(task.season && contextForSeason(task.season)),
                },
            });
        }
    }
    return [...groups.values()].map(({ count, titles, preview }) => ({
        kind: ALERT_KIND.URGENT_TASK,
        count,
        preview: { ...preview, title: titles.join(', ') },
    }));
};

/** Compute lot-valued inventory using Decimal so lots and alert thresholds do not drift. */
const inventorySummary = (farms, products, now) => {
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
        inventory.productCount += 1;
        inventory.stockValue = product.inventoryBalances.reduce(
            (sum, lot) => sum.plus(new Prisma.Decimal(lot.quantity).times(lot.unitPrice)),
            inventory.stockValue,
        );
        // Warehouse thresholds for bottles/packs use the conversion unit, while
        // balances and stock valuation retain their original stock unit.
        const alertQuantity = stockInAlertUnit(product, usableStock(product, product.inventoryBalances, now));
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
                unit: alertUnit(product),
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
            const farmById = new Map(farms.map((farm) => [farm.id, farm]));
            const caseWhere = {
                season: { status: SEASON_STATUS.ACTIVE, pond: { farm: { ownerId, status: FARM_STATUS.ACTIVE } } },
                status: { not: DISEASE_CASE_STATUS.RESOLVED },
            };
            const protocolWhere = { season: visibleSeason(ownerId), status: 'PENDING_APPROVAL' };
            const normalize = (item) => ({
                id: item.id,
                title: item.title,
                // Protocol/case captions use farm and season; pondId still supports navigation.
                ...contextForSeason(item.season, { includePondName: false }),
            });
            const [products, tasks, protocols, cases] = await Promise.all([
                tx.product.findMany({
                    where: { farmId: { in: farmIds }, status: 'ACTIVE' },
                    select: {
                        id: true,
                        name: true,
                        farmId: true,
                        unit: true,
                        status: true,
                        minAlertQuantity: true,
                        conversionQuantity: true,
                        conversionUnit: true,
                        inventoryBalances: {
                            where: { quantity: { gt: 0 } },
                            select: { quantity: true, unitPrice: true, expiryDate: true, receivedAt: true },
                        },
                    },
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                }),
                // Existing task statuses determine actionable work, without soft-delete columns.
                tx.task.findMany({
                    where: {
                        farmId: { in: farmIds },
                        priority: 'URGENT',
                        status: { in: ['PENDING', 'IN_PROGRESS'] },
                        OR: [{ seasonId: null }, { season: { pond: { farm: { ownerId } } } }],
                    },
                    select: { id: true, title: true, farmId: true, seasonId: true, season: { select: seasonContextSelect } },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                }),
                tx.protocol.findMany({
                    where: {
                        ...protocolWhere,
                        OR: [
                            { protocolType: 'PRODUCTION' },
                            { protocolType: 'TREATMENT', diseaseCase: caseWhere },
                        ],
                    },
                    select: {
                        id: true,
                        title: true,
                        protocolType: true,
                        season: { select: seasonContextSelect },
                    },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                }),
                tx.diseaseCase.findMany({
                    where: caseWhere,
                    select: {
                        id: true,
                        title: true,
                        status: true,
                        season: { select: seasonContextSelect },
                    },
                    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                }),
            ]);
            const { inventories, lowStockAlerts } = inventorySummary(farms, products, now);
            const urgentAlerts = urgentTaskAlerts(tasks, farmById);
            const pendingAlerts = protocols.map((item) => ({
                kind: item.protocolType === 'TREATMENT' ? ALERT_KIND.PENDING_TREATMENT : ALERT_KIND.PENDING_PRODUCTION,
                count: 1,
                preview: normalize(item),
            }));
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
                alerts: [...urgentAlerts, ...pendingAlerts, ...lowStockAlerts, ...diseaseAlerts(cases)],
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
 * Aggregate known harvest revenue and execution-linked receipt-layer costs (BR-127/128).
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
                   coalesce(h.total_revenue, 0) AS income, 0::numeric AS cost,
                   (h.total_revenue IS NULL)::int AS unpriced, (h.total_revenue IS NOT NULL)::int AS priced
            FROM harvest_events h
            JOIN aquaculture_seasons s ON s.id = h.season_id
            JOIN ponds p ON p.id = s.pond_id
            JOIN farms f ON f.id = p.farm_id CROSS JOIN bounds b
            WHERE f.owner_id = ${ownerId}::uuid ${farmFilter}
              AND h.harvested_at >= b.from_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
              AND h.harvested_at < (b.to_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
            UNION ALL
            SELECT date_trunc('month', e.executed_at AT TIME ZONE 'Asia/Ho_Chi_Minh'),
                   0::numeric, t.total_amount, 0, 0
            FROM inventory_transactions t
            JOIN operation_executions e ON t.reference_type = 'operation_execution' AND e.id = t.reference_id
            JOIN operation_schedules os ON os.id = e.schedule_id AND os.season_id = t.season_id
            JOIN products pr ON pr.id = t.product_id
            JOIN aquaculture_seasons s ON s.id = t.season_id
            JOIN ponds p ON p.id = s.pond_id
            JOIN farms f ON f.id = p.farm_id CROSS JOIN bounds b
            WHERE f.owner_id = ${ownerId}::uuid ${farmFilter}
              AND pr.farm_id = f.id AND t.transaction_type = 'stock_out'
              AND (e.actual_product_id IS NULL OR e.actual_product_id = t.product_id)
              AND e.executed_at >= b.from_date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
              AND e.executed_at < (b.to_date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        )
        SELECT to_char(m.month, 'YYYY-MM') AS month,
               coalesce(sum(facts.income), 0) AS income, coalesce(sum(facts.cost), 0) AS cost,
               coalesce(sum(facts.unpriced), 0)::int AS "unpricedHarvests",
               coalesce(sum(facts.priced), 0)::int AS "pricedHarvests"
        FROM bounds b CROSS JOIN LATERAL generate_series(
            date_trunc('month', b.from_date::timestamp), date_trunc('month', b.to_date::timestamp), interval '1 month'
        ) m(month)
        LEFT JOIN facts ON facts.month = m.month
        GROUP BY m.month ORDER BY m.month
    `);
    const income = rows.reduce((sum, row) => sum.plus(row.income), new Prisma.Decimal(0));
    const cost = rows.reduce((sum, row) => sum.plus(row.cost), new Prisma.Decimal(0));
    const unpricedHarvests = rows.reduce((sum, row) => sum + Number(row.unpricedHarvests ?? 0), 0);
    const pricedHarvests = rows.reduce((sum, row) => sum + Number(row.pricedHarvests ?? 0), 0);
    const undetermined = unpricedHarvests > 0 && pricedHarvests === 0;
    return {
        ...range,
        months: rows.map((row) => ({
            month: row.month,
            income: Number(row.unpricedHarvests ?? 0) > 0 && Number(row.pricedHarvests ?? 0) === 0 ? null : Number(row.income),
            cost: Number(row.cost),
            unpricedHarvests: Number(row.unpricedHarvests ?? 0),
        })),
        totals: {
            income: undetermined ? null : Number(income), cost: Number(cost),
            // Kept as an API compatibility key; the UI labels this material margin, not full profit.
            profit: undetermined ? null : Number(income.minus(cost)), unpricedHarvests,
        },
    };
};

module.exports = { getOverview, getFinance };
