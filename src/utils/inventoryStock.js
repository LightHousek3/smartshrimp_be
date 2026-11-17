const { Prisma } = require('@prisma/client');
const { vietnamDate } = require('./inventoryQuantity');

const decimal = (value) => new Prisma.Decimal(value ?? 0);
const packaged = (product) =>
    ['PACK', 'BOTTLE'].includes(product.unit) &&
    product.conversionUnit &&
    decimal(product.conversionQuantity).gt(0);
const stockInAlertUnit = (product, quantity) =>
    packaged(product) ? decimal(quantity).mul(product.conversionQuantity) : decimal(quantity);
const alertUnit = (product) => (packaged(product) ? product.conversionUnit : product.unit);
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
