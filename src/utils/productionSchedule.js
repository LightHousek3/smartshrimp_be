const { Prisma } = require('@prisma/client');
const { occursOn, doseAtDay } = require('./productionProtocolV2');

const DAY_MS = 86400000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const dateInVietnam = (at) => new Date(at.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
const positive = value => value != null && new Prisma.Decimal(value).gt(0);

/** Compare freshness at the occurrence, not just when the worker happens to run. */
const biomassAt = (logs, scheduledAt, now, maxAgeHours) => logs.find(log =>
    !log.isVoided && positive(log.estimatedBiomassKg)
    && log.recordedAt <= now && log.recordedAt <= scheduledAt
    && scheduledAt - log.recordedAt <= maxAgeHours * 60 * 60 * 1000);

const calculate = (item, doc, scheduledAt, { volumeM3, healthLogs, now, biomassMaxAgeHours }) => {
    const dose = doseAtDay(item, doc);
    let quantity = dose, basisQuantity = null, basisUnit = null, sourceHealthLogId = null;
    if (item.doseBasis === 'PER_M3_WATER') {
        if (!positive(volumeM3)) return { blocked: 'VOLUME_MISSING' };
        basisQuantity = new Prisma.Decimal(volumeM3);
        basisUnit = 'm3_water';
        quantity = dose.times(basisQuantity);
    } else if (['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(item.doseBasis)) {
        const log = biomassAt(healthLogs, scheduledAt, now, biomassMaxAgeHours);
        if (!log) return { blocked: 'BIOMASS_MISSING_OR_STALE' };
        basisQuantity = new Prisma.Decimal(log.estimatedBiomassKg);
        basisUnit = 'kg_biomass';
        sourceHealthLogId = log.id;
        quantity = dose.times(basisQuantity);
        if (item.doseBasis === 'PERCENT_BIOMASS') {
            if (!['KG', 'G'].includes(item.doseUnit) || dose.gt(100)) return { blocked: 'DOSE_INVALID' };
            quantity = quantity.div(100).times(item.doseUnit === 'G' ? 1000 : 1);
        }
    } else if (item.doseBasis !== 'FIXED_QUANTITY') return { blocked: 'DOSE_INVALID' };
    if (basisQuantity && basisQuantity.gt('99999999999.999')) return { blocked: 'BASIS_OUT_OF_RANGE' };
    quantity = quantity.toDecimalPlaces(9, Prisma.Decimal.ROUND_HALF_UP);
    if (!quantity.gt(0) || quantity.gt('99999999999.999999999') || !dose.gt(0) || dose.gt('9999999999.9999')) {
        return { blocked: 'QUANTITY_OUT_OF_RANGE' };
    }
    return { plannedQuantity: quantity, unit: item.doseUnit,
        doseBasisSnapshot: item.doseBasis, doseValueSnapshot: dose,
        basisQuantity, basisUnit, sourceHealthLogId,
        calculationVersion: 'production-v2-biomass-24h', calculatedAt: now };
};

/** Item anchors survive rolling windows; SQL DATE is a calendar anchor, not local midnight UTC. */
const occurrences = (protocol, now) => {
    if (!protocol.season.stockingDate) return [];
    const anchor = protocol.season.stockingDate.toISOString().slice(0, 10);
    const today = Date.parse(dateInVietnam(now));
    const windowDays = Math.min(14, Math.max(1, protocol.rollingWindowDays));
    const rows = [];
    for (let index = 0; index < windowDays; index++) {
        const calendarDay = today + index * DAY_MS;
        const doc = Math.round((calendarDay - Date.parse(anchor)) / DAY_MS) + 1;
        for (const item of protocol.items) {
            if (!item.plannedTime || !occursOn(item, doc)) continue;
            const scheduledAt = new Date(`${new Date(calendarDay).toISOString().slice(0, 10)}T${item.plannedTime.toISOString().slice(11, 23)}+07:00`);
            if (scheduledAt < now) continue;
            rows.push({ item, doc, scheduledAt });
        }
    }
    return rows;
};

/** Log diagnostic identifiers only; Prisma messages/meta may contain SQL values or credentials. */
const errorDetail = (error) => {
    const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'unknown';
    const target = [error?.meta?.target].flat().map(identifier).join(',');
    const origin = typeof error?.stack === 'string'
        ? error.stack.split('\n').slice(1).join('\n').match(/[\\/]src[\\/][A-Za-z0-9_./\\-]+:\d+:\d+/)?.[0].slice(1) : null;
    return `error=${identifier(error?.name)} code=${identifier(error?.code)} databaseCode=${identifier(error?.meta?.code)} clientVersion=${identifier(error?.clientVersion)} model=${identifier(error?.meta?.modelName)} target=${target} origin=${origin ?? 'unknown'}`;
};

module.exports = { biomassAt, calculate, occurrences, dateInVietnam, errorDetail };
