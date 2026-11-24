const { Prisma } = require('@prisma/client');
const { vietnamDate } = require('./inventoryQuantity');

/**
 * Keep stock calculations exact and use zero for absent totals.
 */
const decimal = (value) => new Prisma.Decimal(value ?? 0);
/**
 * Convert packs and bottles only when a positive amount per package is configured.
 */
const packaged = (product) =>
    ['PACK', 'BOTTLE'].includes(product.unit) &&
    product.conversionUnit &&
    decimal(product.conversionQuantity).gt(0);
/**
 * Express quantity in the alert threshold unit for products with package conversions.
 */
const stockInAlertUnit = (product, quantity) =>
    packaged(product) ? decimal(quantity).mul(product.conversionQuantity) : decimal(quantity);
/**
 * Use the conversion unit for alerts when a package has a usable conversion.
 */
const alertUnit = (product) => (packaged(product) ? product.conversionUnit : product.unit);
/**
 * Count positive lots already received that remain valid on the Vietnam calendar date.
 */
const usableWhere = (productId, at) => ({
    productId,
    quantity: { gt: 0 },
    receivedAt: { lte: at },
    expiryDate: { gte: vietnamDate(at) },
});

/** Ledger stock and value remain unchanged when expiry removes a lot from operational availability. */
const usableStock = (product, balances, at = new Date()) =>
    product.status !== 'ACTIVE'
        ? decimal(0)
        : balances
              .filter(
                  (row) =>
                      row.expiryDate && row.expiryDate >= vietnamDate(at) && row.receivedAt <= at,
              )
              .reduce(
                  (sum, row) => sum.add(Prisma.Decimal.max(0, decimal(row.quantity))),
                  decimal(0),
              );
/**
 * Aggregate operationally usable lots through the caller's database client and return zero for
 * archived products.
 */
const readUsableStock = async (client, product, at = new Date()) =>
    product.status !== 'ACTIVE'
        ? decimal(0)
        : decimal(
              (
                  await client.inventoryBalance.aggregate({
                      where: usableWhere(product.id, at),
                      _sum: { quantity: true },
                  })
              )._sum.quantity,
          );

module.exports = { stockInAlertUnit, alertUnit, usableStock, readUsableStock };
