const { Prisma } = require('@prisma/client');

/**
 * Read quantitative provenance for already authorized seasons in one batch.
 * harvest_events has no Prisma delegate; lateral reads also preserve exact ordering
 * of the latest measurement and newer population without loading their full histories.
 * All reads remain on the caller's transaction snapshot; this function grants no access.
 */
const readSources = async (client, seasonIds, at) => {
    if (!seasonIds.length) return new Map();
    const rows = await client.$queryRaw(Prisma.sql`
        SELECT s.id AS "seasonId", b.id, b.recorded_at AS "recordedAt",
            b.estimated_biomass_kg AS "estimatedBiomassKg", b.estimated_population AS "estimatedPopulation",
            p.id AS "populationId", p.recorded_at AS "populationAt", p.estimated_population AS "latestPopulation",
            h.harvested_at AS "latestPartialHarvestAt"
        FROM aquaculture_seasons s
        LEFT JOIN LATERAL (
            SELECT l.id, l.recorded_at, l.estimated_biomass_kg, l.estimated_population
            FROM shrimp_health_logs l
            WHERE l.season_id = s.id AND NOT l.is_voided AND l.recorded_at <= ${at}
                AND l.estimated_biomass_kg IS NOT NULL
            ORDER BY l.recorded_at DESC, l.created_at DESC, l.id DESC LIMIT 1
        ) b ON true
        LEFT JOIN LATERAL (
            SELECT l.id, l.recorded_at, l.estimated_population
            FROM shrimp_health_logs l
            WHERE l.season_id = s.id AND NOT l.is_voided AND l.recorded_at <= ${at}
                AND l.estimated_population IS NOT NULL
            ORDER BY l.recorded_at DESC, l.created_at DESC, l.id DESC LIMIT 1
        ) p ON true
        LEFT JOIN LATERAL (
            SELECT harvested_at FROM harvest_events
            WHERE season_id = s.id AND harvest_type = 'partial' AND harvested_at <= ${at}
            ORDER BY harvested_at DESC, id DESC LIMIT 1
        ) h ON true
        WHERE s.id IN (${Prisma.join(seasonIds.map(id => Prisma.sql`${id}::uuid`))})`);
    return new Map(rows.map(row => [row.seasonId, row]));
};

/**
 * A later population estimate cannot silently renew or contradict an older biomass.
 * Unknown population provenance is insufficient to reconcile a changed estimate.
 */
const populationMatches = (source) => !source.populationAt || !source.recordedAt
    || source.populationAt < source.recordedAt || source.populationId === source.id
    || (source.estimatedPopulation != null && source.latestPopulation != null
        && String(source.estimatedPopulation) === String(source.latestPopulation));

module.exports = { readSources, populationMatches };
