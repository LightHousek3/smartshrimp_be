/**
 * Read immutable harvest history and record partial or final harvests for farm owners.
 * Writes coordinate through the season row lock; final harvest also completes the season.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { HARVEST_MESSAGES: M } = require('../constants');

// Use the supplied client so ownership checks and row locks share the caller's transaction.
const scope = async (tx, ownerId, seasonId, write = false) => {
    // Lock the aggregate only for writes, coordinating completion with season updates.
    if (write) await tx.$queryRaw`SELECT s.id FROM aquaculture_seasons s
        JOIN ponds p ON p.id = s.pond_id JOIN farms f ON f.id = p.farm_id
        WHERE s.id = ${seasonId}::uuid AND f.owner_id = ${ownerId}::uuid FOR UPDATE OF s`;
    const season = await tx.aquacultureSeason.findFirst({
        where: { id: seasonId, pond: { farm: { ownerId } } },
        select: { id: true, name: true, status: true, stockingDate: true, initialQuantity: true,
            pond: { select: { id: true, name: true, farm: { select: { id: true, name: true } } } } },
    });
    if (!season) throw ApiError.notFound(M.NOT_FOUND);
    return season;
};

// BigInt counts become strings for lossless JSON serialization; decimals follow the numeric API contract.
const normalize = (row, season) => ({
    id: row.id, seasonId: row.season_id, harvestType: row.harvest_type.toUpperCase(),
    harvestedAt: row.harvested_at.toISOString(),
    quantityCount: row.quantity_count == null ? null : String(row.quantity_count),
    totalWeightKg: Number(row.total_weight_kg),
    avgSizePerKg: row.avg_size_per_kg == null ? null : Number(row.avg_size_per_kg),
    pricePerKg: row.price_per_kg == null ? null : Number(row.price_per_kg),
    totalRevenue: row.total_revenue == null ? null : Number(row.total_revenue),
    estimatedRemainingCount: row.estimated_remaining_count == null ? null : String(row.estimated_remaining_count),
    buyerName: row.buyer_name, buyerContact: row.buyer_contact, note: row.note,
    recordedBy: row.recorded_by, recorderName: row.recorder_name || null,
    createdAt: row.created_at.toISOString(),
    season: { id: season.id, name: season.name, status: season.status, pond: season.pond },
});

// harvest_events exists in SQL but has no Prisma delegate. All fragments below are
// static identifiers or Prisma-bound values, never interpolated request SQL.
const readRows = (tx, where, tail = Prisma.empty) => tx.$queryRaw(Prisma.sql`
    SELECT h.*, a.full_name AS recorder_name FROM harvest_events h
    JOIN accounts a ON a.id = h.recorded_by WHERE ${where} ${tail}`);

// RepeatableRead keeps page rows and aggregate totals on the same database snapshot.
const list = (ownerId, seasonId, query = {}) => prisma.$transaction(async (tx) => {
    const season = await scope(tx, ownerId, seasonId);
    const { limit = 20, cursor, harvestType, from, to } = query;
    const where = Prisma.sql`h.season_id = ${seasonId}::uuid
        ${harvestType ? Prisma.sql`AND h.harvest_type = ${harvestType.toLowerCase()}::harvest_type` : Prisma.empty}
        ${from ? Prisma.sql`AND h.harvested_at >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND h.harvested_at <= ${to}` : Prisma.empty}`;
    let cursorFilter = Prisma.empty;
    if (cursor) {
        // A cursor must belong to this season and match the current filters.
        const [anchor] = await readRows(tx, Prisma.sql`${where} AND h.id = ${cursor}::uuid`);
        if (!anchor) throw ApiError.badRequest(M.INVALID_CURSOR);
        // Compare in PostgreSQL to retain microseconds lost by JavaScript Date.
        cursorFilter = Prisma.sql`AND (h.harvested_at, h.id) <
            (SELECT harvested_at, id FROM harvest_events WHERE id = ${cursor}::uuid)`;
    }
    // Fetch one extra row to detect another page without a separate existence query.
    const rows = await readRows(tx, Prisma.sql`${where} ${cursorFilter}`,
        Prisma.sql`ORDER BY h.harvested_at DESC, h.id DESC LIMIT ${limit + 1}`);
    // Totals describe the full filtered result, regardless of the current cursor.
    const [totals] = await tx.$queryRaw(Prisma.sql`SELECT count(*)::int AS count,
        coalesce(sum(h.total_weight_kg), 0) AS weight,
        coalesce(sum(h.total_revenue), 0) AS revenue FROM harvest_events h WHERE ${where}`);
    const items = rows.slice(0, limit).map((row) => normalize(row, season));
    const hasNextPage = rows.length > limit;
    return { items, meta: { limit, totalResults: totals.count, hasNextPage,
        nextCursor: hasNextPage ? items[items.length - 1].id : null,
        totalWeightKg: Number(totals.weight), totalRevenue: Number(totals.revenue) } };
}, { isolationLevel: 'RepeatableRead' });

// Resolve ownership first, then restrict the requested event to that same season.
const detail = async (ownerId, seasonId, harvestId) => {
    const season = await scope(prisma, ownerId, seasonId);
    const [row] = await readRows(prisma, Prisma.sql`h.season_id = ${seasonId}::uuid AND h.id = ${harvestId}::uuid`);
    if (!row) throw ApiError.notFound(M.NOT_FOUND);
    return normalize(row, season);
};

// Treat omitted, blank, and whitespace-only optional text as the same persisted value.
const nullableText = (value) => value?.trim() || null;
// Canonicalize request and stored values so retries compare content rather than representation.
const comparable = (body) => ({
    harvestType: body.harvestType, harvestedAt: new Date(body.harvestedAt).toISOString(),
    totalWeightKg: Number(body.totalWeightKg), quantityCount: body.quantityCount == null ? null : String(body.quantityCount),
    pricePerKg: body.pricePerKg == null ? null : Number(body.pricePerKg),
    estimatedRemainingCount: body.harvestType === 'FINAL' ? '0' : String(body.estimatedRemainingCount),
    buyerName: nullableText(body.buyerName), buyerContact: nullableText(body.buyerContact), note: nullableText(body.note),
});

/**
 * Record a validated request once, or replay its saved event when the retry key matches.
 * All write-path queries use the same transaction client so failures abort the entire write.
 */
const create = async (ownerId, seasonId, body, key) => {
    try {
        return await prisma.$transaction(async (tx) => {
            const season = await scope(tx, ownerId, seasonId, true);
            const input = comparable(body);
            const [existing] = await readRows(tx, Prisma.sql`h.idempotency_key = ${key}::uuid`);
            // Replays precede the ACTIVE check so a lost final response remains recoverable.
            if (existing) {
                // A retry key is reusable only by the same owner, season, and payload.
                if (existing.season_id !== seasonId || existing.recorded_by !== ownerId) throw ApiError.conflict(M.KEY_CONFLICT);
                const saved = normalize(existing, season);
                if (JSON.stringify(comparable(saved)) !== JSON.stringify(input)) throw ApiError.conflict(M.KEY_CONFLICT);
                return { event: saved, replayed: true };
            }
            if (season.status !== 'ACTIVE') throw ApiError.conflict(M.INACTIVE);
            const [latest] = await readRows(tx, Prisma.sql`h.season_id = ${seasonId}::uuid`,
                Prisma.sql`ORDER BY h.harvested_at DESC, h.id DESC LIMIT 1`);
            const harvestedAt = new Date(input.harvestedAt);
            // Stocking and completion use calendar dates in Vietnam (UTC+7).
            const vietnamDay = new Date(harvestedAt.getTime() + 7 * 3600000).toISOString().slice(0, 10);
            if (harvestedAt > new Date() || (season.stockingDate && vietnamDay < season.stockingDate.toISOString().slice(0, 10))
                || (latest && harvestedAt < latest.harvested_at)) throw ApiError.badRequest(M.INVALID_TIME);
            // The latest remaining estimate replaces the initial stock as the population ceiling.
            const available = latest?.estimated_remaining_count ?? season.initialQuantity;
            const quantity = input.quantityCount == null ? 0n : BigInt(input.quantityCount);
            const remaining = BigInt(input.estimatedRemainingCount);
            if (available != null && (quantity + remaining > BigInt(available))) throw ApiError.badRequest(M.INVALID_QUANTITY);
            // Decimal arithmetic avoids binary floating-point drift in revenue and size calculations.
            const weight = new Prisma.Decimal(input.totalWeightKg);
            const price = input.pricePerKg == null ? null : new Prisma.Decimal(input.pricePerKg);
            const revenue = price == null ? null : weight.mul(price).toDecimalPlaces(2);
            const size = quantity === 0n ? null : new Prisma.Decimal(quantity.toString()).div(weight).toDecimalPlaces(2);
            // Reject values outside the SQL numeric column limits before inserting.
            if (revenue?.gte('10000000000000000') || size?.gte('100000000') || size?.lte(0)) throw ApiError.badRequest(M.INVALID_QUANTITY);
            const [row] = await tx.$queryRaw(Prisma.sql`INSERT INTO harvest_events
                (season_id, harvest_type, harvested_at, quantity_count, total_weight_kg,
                 avg_size_per_kg, price_per_kg, total_revenue, estimated_remaining_count,
                 buyer_name, buyer_contact, note, recorded_by, idempotency_key)
                VALUES (${seasonId}::uuid, ${input.harvestType.toLowerCase()}::harvest_type,
                    ${harvestedAt}, ${input.quantityCount}::bigint, ${weight}::numeric,
                    ${size}::numeric, ${price}::numeric, ${revenue}::numeric, ${remaining.toString()}::bigint,
                    ${input.buyerName}, ${input.buyerContact}, ${input.note}, ${ownerId}::uuid, ${key}::uuid)
                RETURNING *, (SELECT full_name FROM accounts WHERE id = ${ownerId}::uuid) AS recorder_name`);
            if (input.harvestType === 'FINAL') {
                // The event and season completion must commit together or both roll back.
                const changed = await tx.aquacultureSeason.updateMany({
                    where: { id: seasonId, status: 'ACTIVE' },
                    data: { status: 'COMPLETED', actualEndDate: new Date(`${vietnamDay}T00:00:00Z`) },
                });
                if (changed.count !== 1) throw ApiError.conflict(M.CONFLICT);
                season.status = 'COMPLETED';
            }
            return { event: normalize(row, season), replayed: false };
        }, { isolationLevel: 'Serializable' });
    } catch (error) {
        // Surface uniqueness, serialization, and deadlock conflicts without retrying the write here.
        if (['P2002', 'P2034'].includes(error.code)
            || (error.code === 'P2010' && ['23505', '40001', '40P01'].includes(error.meta?.code))) {
            throw ApiError.conflict(M.CONFLICT);
        }
        throw error;
    }
};
module.exports = { list, detail, create };
