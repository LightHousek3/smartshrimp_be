const messages = require('../constants/messages.js');
const { DoseBasis, OperationType, ProductUnit } = require('@prisma/client');
const ApiError = require('./ApiError');

const doseUnitsForProduct = ({ unit, conversionUnit }) => {
    const baseUnit = ['PACK', 'BOTTLE'].includes(unit) ? conversionUnit : unit;
    if (['MG', 'G', 'KG'].includes(baseUnit))
        return [ProductUnit.G, ProductUnit.KG];
    if (['ML', 'L'].includes(baseUnit)) return [ProductUnit.ML, ProductUnit.L];
    return [ProductUnit.PCS];
};

/** DOC is one-based; a dose is for one occurrence, never an automatically prescribed daily total. */
const assertTemplateDose = (item, product, startDay, environment) => {
    // Recheck derived values after explicit dates have been compacted into stored rules.
    if (
        !Number.isFinite(item.doseValue) ||
        item.doseValue <= 0 ||
        item.doseValue > 9999999999
    )
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_DOSE
        );
    // The material fixes the operation; the meal/environment section fixes the application route.
    const operationType =
        product.category === 'FEED' ? OperationType.FEEDING : product.category;
    if (
        !Object.values(OperationType).includes(operationType) ||
        item.operationType !== operationType
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.OPERATION_REQUIRED
        );
    }
    const increment = item.dailyDoseIncrement ?? 0;
    if (!Number.isFinite(increment) || increment < 0)
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_DAILY_INCREMENT
        );
    if (
        increment > 0 &&
        (operationType !== OperationType.FEEDING ||
            environment ||
            item.doseBasis !== DoseBasis.FIXED_QUANTITY ||
            (item.repeatIntervalDays ?? 1) !== 1 ||
            (item.endDay ?? startDay) > 29 ||
            !['KG', 'G'].includes(item.doseUnit))
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INVALID_DAILY_INCREMENT
        );
    }
    if (
        item.doseValue + increment * ((item.endDay ?? startDay) - startDay) >
        9999999999
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.FINAL_DOSE_EXCEEDED
        );
    }
    if (
        (operationType === OperationType.FEEDING &&
            (environment || product.category !== 'FEED')) ||
        (operationType === OperationType.CHEMICAL && !environment)
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INCOMPATIBLE_OPERATION_ROUTE
        );
    }
    const fixed = item.doseBasis === DoseBasis.FIXED_QUANTITY;
    const biomass = [
        DoseBasis.PERCENT_BIOMASS,
        DoseBasis.PER_KG_BIOMASS,
    ].includes(item.doseBasis);
    if (
        (operationType !== OperationType.OTHER &&
            !(
                fixed ||
                (environment
                    ? item.doseBasis === DoseBasis.PER_M3_WATER
                    : startDay >= 30 && biomass)
            )) ||
        (operationType === OperationType.OTHER && !fixed)
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.DOC_DOSING_RULE
        );
    }
    if (
        !doseUnitsForProduct(product).includes(item.doseUnit) ||
        (item.doseBasis === DoseBasis.PERCENT_BIOMASS &&
            !['G', 'KG'].includes(item.doseUnit)) ||
        (item.doseBasis === DoseBasis.PERCENT_BIOMASS && item.doseValue > 100)
    ) {
        throw ApiError.badRequest(
            messages.EXPERT_PROTOCOL_TEMPLATE.INCOMPATIBLE_DOSE_UNIT
        );
    }
    return operationType;
};

module.exports = { assertTemplateDose, doseUnitsForProduct };
