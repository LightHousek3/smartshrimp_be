/** Shared population accounting for harvests and derived shrimp-health estimates. */
const { Prisma } = require('@prisma/client');
const { isWeightSample } = require('../utils/biomassSource');

/**
 * Calculate available population from stocking or the last recorded harvest remainder.
 * Preserve the saved remainder from older harvests with a manual correction.
 * Legacy tied harvests use the conservative minimum; health ties follow creation order.
 */
const populationAvailable = (season, at, through = null) => Prisma.sql`(SELECT
    CASE WHEN capacity < 0 THEN 0 ELSE capacity END FROM (SELECT
        CASE WHEN h.id IS NULL THEN ${season.initialQuantity}::bigint
            WHEN h.harvest_type = 'final' THEN 0
            ELSE h.estimated_remaining_count END
        - (SELECT coalesce(sum(l.mortality_count), 0) FROM shrimp_health_logs l
            WHERE l.season_id = ${season.id}::uuid AND l.is_voided = false AND l.recorded_at <= ${at}
                ${through ? Prisma.sql`AND (l.recorded_at < ${at} OR
                    (l.created_at, l.id) <= (${through.createdAt}, ${through.id}))` : Prisma.empty}
                AND (h.id IS NULL OR l.recorded_at > h.harvested_at)) AS capacity
        FROM (SELECT 1) anchor LEFT JOIN LATERAL (
            SELECT id, harvest_type, harvested_at, estimated_remaining_count FROM harvest_events
            WHERE season_id = ${season.id}::uuid AND harvested_at <= ${at}
            ORDER BY harvested_at DESC, estimated_remaining_count ASC NULLS LAST, id DESC LIMIT 1
        ) h ON true) population)`;


/** Read the live-population reference at an observation time using the caller's snapshot. */
const availableAt = async (client, season, at) => {
    const [row] = await client.$queryRaw(Prisma.sql`SELECT ${populationAvailable(season, at)} AS available`);
    return row?.available == null ? null : BigInt(row.available);
};

/** Recompute derived health facts without carrying a pre-harvest estimate past a harvest. */
const recalculateHealthPopulations = async (tx, season) => {
    const logs = await tx.shrimpHealthLog.findMany({
        where: { seasonId: season.id, isVoided: false },
        orderBy: [{ recordedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!logs.length) return;
    const populations = await tx.$queryRaw(Prisma.sql`SELECT health.id,
        ${populationAvailable(season, Prisma.sql`health.recorded_at`, {
        createdAt: Prisma.sql`health.created_at`, id: Prisma.sql`health.id`,
    })} AS available
        FROM shrimp_health_logs health WHERE health.season_id = ${season.id}::uuid AND health.is_voided = false`);
    const byId = new Map(populations.map(row => [row.id, row.available]));
    for (const log of logs) {
        const available = byId.get(log.id);
        // Unknown stocking/harvest data cannot justify overwriting a manually supplied estimate.
        if (available == null) continue;
        const population = BigInt(available);
        const populationChanged = log.estimatedPopulation == null || BigInt(log.estimatedPopulation) !== population;
        // Preserve old estimates without treating them as new weighings.
        const biomass = isWeightSample(log)
            ? new Prisma.Decimal(population.toString()).mul(log.avgWeightG).div(1000).toDecimalPlaces(3)
            : log.estimatedBiomassKg;
        const biomassChanged = biomass == null || log.estimatedBiomassKg == null
            ? (biomass ?? null) !== (log.estimatedBiomassKg ?? null)
            : !new Prisma.Decimal(biomass).eq(log.estimatedBiomassKg);

        if (populationChanged || biomassChanged) {
            await tx.shrimpHealthLog.update({
                where: { id: log.id },
                data: { estimatedPopulation: population, estimatedBiomassKg: biomass },
            });
        }
    }
};

module.exports = { populationAvailable, availableAt, recalculateHealthPopulations };
