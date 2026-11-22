/** Population observations cannot silently renew or contradict a quantitative measurement. */
const populationMatches = (source) =>
    (source.estimatedPopulation == null || Number(source.estimatedPopulation) > 0) &&
    (source.latestPopulation == null || Number(source.latestPopulation) > 0) &&
    (!source.populationAt ||
        !source.recordedAt ||
        source.populationAt < source.recordedAt ||
        source.populationId === source.id ||
        (source.estimatedPopulation != null &&
            source.latestPopulation != null &&
            String(source.estimatedPopulation) === String(source.latestPopulation)));

const newestFirst = (a, b) =>
    new Date(b.recordedAt) - new Date(a.recordedAt) ||
    new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0) ||
    String(b.id ?? '').localeCompare(String(a.id ?? ''));

/** Select evidence available at the occurrence; an invalid newer estimate cannot fall back to an older dose. */
const selectBiomass = (logs, scheduledAt, now, maxAgeHours, latestHarvestAt) => {
    const eligible = logs
        .filter(
            (log) =>
                !log.isVoided &&
                log.recordedAt <= now &&
                log.recordedAt <= scheduledAt &&
                (!log.createdAt || (log.createdAt <= now && log.createdAt <= scheduledAt)),
        )
        .sort(newestFirst);
    const measured = eligible.find((log) => log.estimatedBiomassKg != null);
    if (
        !measured ||
        !(Number(measured.estimatedBiomassKg) > 0) ||
        (latestHarvestAt && measured.recordedAt <= latestHarvestAt) ||
        scheduledAt - measured.recordedAt > maxAgeHours * 3600000
    )
        return null;
    const population = eligible.find((log) => log.estimatedPopulation != null);
    return populationMatches({
        ...measured,
        populationId: population?.id,
        populationAt: population?.recordedAt,
        latestPopulation: population?.estimatedPopulation,
    })
        ? measured
        : null;
};

module.exports = { populationMatches, selectBiomass };
