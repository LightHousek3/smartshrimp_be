const { Prisma } = require('@prisma/client');
const ApiError = require('./ApiError');
const { messages, PRODUCT_UNIT, INVENTORY_LIMITS } = require('../constants');

const packagedUnits = [PRODUCT_UNIT.PACK, PRODUCT_UNIT.BOTTLE];

const units = {
    MG: {
        family: 'mass',
        factor: '0.000001',
    },
    G: {
        family: 'mass',
        factor: '0.001',
    },
    KG: {
        family: 'mass',
        factor: '1',
    },
    ML: {
        family: 'volume',
        factor: '0.001',
    },
    L: {
        family: 'volume',
        factor: '1',
    },
};

/**
 * Convert an execution quantity to stock units with decimal arithmetic and V2 scale.
 */
const stockQuantity = (actual, sourceUnit, product) => {
    const quantity = new Prisma.Decimal(actual);
    if (!quantity.isFinite() || quantity.lte(0)) {
        throw ApiError.badRequest(messages.INVENTORY.INVALID_EXECUTION_QUANTITY);
    }
    let result = quantity;
    if (sourceUnit !== product.unit) {
        const source = units[sourceUnit];
        const targetUnit = packagedUnits.includes(product.unit) ? product.conversionUnit : product.unit;
        const target = units[targetUnit];
        if (!source || !target || source.family !== target.family) {
            throw ApiError.badRequest(messages.INVENTORY.INCOMPATIBLE_EXECUTION_UNIT);
        }
        result = quantity.mul(source.factor).div(target.factor);
        if (packagedUnits.includes(product.unit)) {
            if (!product.conversionQuantity || new Prisma.Decimal(product.conversionQuantity).lte(0)) {
                throw ApiError.badRequest(messages.INVENTORY.INVALID_CONVERSION);
            }
            result = result.div(product.conversionQuantity);
        }
    }
    result = result.toDecimalPlaces(9);
    if (result.lte(0) || result.gt(INVENTORY_LIMITS.MAX_BALANCE_QUANTITY)) {
        throw ApiError.badRequest(messages.INVENTORY.CONVERTED_QUANTITY_LIMIT);
    }
    return result;
};

/**
 * Expiry dates are inclusive calendar days in Vietnam, independent of the API host timezone.
 */
const vietnamDate = (instant) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(instant).map(({ type, value }) => [type, value]));
    return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
};

module.exports = {
    stockQuantity,
    vietnamDate,
};
