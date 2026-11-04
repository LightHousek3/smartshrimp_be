const { allowedProductionProtocolDoseBases, DOSE_BASIS, messages } = require('../constants');
const ApiError = require('./ApiError');

/** SQL DATE is a calendar date; stocking day is DOC 1 regardless of the host timezone. */
const expectedHarvestDoc = ({ stockingDate, expectedEndDate } = {}) => {
    if (!stockingDate || !expectedEndDate) return null;
    const dateOnly = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
    const doc = (Date.parse(dateOnly(expectedEndDate)) - Date.parse(dateOnly(stockingDate))) / (24 * 60 * 60 * 1000) + 1;
    return Number.isInteger(doc) && doc >= 1 ? doc : null;
};

const assertProtocolHarvestCoverage = (stages, season) => {
    const minimumDoc = expectedHarvestDoc(season);
    if (minimumDoc == null) return;
    const lastDoc = stages.reduce((last, stage) => Math.max(last, stage.endDayOffset + 1), 0);
    if (lastDoc < minimumDoc) throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.HARVEST_COVERAGE(minimumDoc));
};

// Day bounds are inclusive. Compare every pair without changing display order.
const hasOverlappingStages = (stages) => stages.some((stage, index) => (
    stages.slice(index + 1).some((other) => (
        stage.startDayOffset <= other.endDayOffset && other.startDayOffset <= stage.endDayOffset
    ))
));

const isProductionProtocolDoseValid = (item, offset) => (
    allowedProductionProtocolDoseBases(item.operationType, offset).includes(item.doseBasis)
    && (item.doseBasis !== DOSE_BASIS.PERCENT_BIOMASS
        || (Number(item.doseValue) <= 100 && ['KG', 'G'].includes(item.doseUnit)))
);

module.exports = { hasOverlappingStages, isProductionProtocolDoseValid, expectedHarvestDoc, assertProtocolHarvestCoverage };
