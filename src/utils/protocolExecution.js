const { Prisma } = require('@prisma/client');

const TIMING = Object.freeze({ ON_TIME: 'ON_TIME', EARLY: 'EARLY', LATE: 'LATE',
    PENDING: 'PENDING', OVERDUE: 'OVERDUE', CANCELLED: 'CANCELLED', UNKNOWN: 'UNKNOWN' });
const MINUTE_MS = 60000;

/** Compare persisted schedule units; never turn a reporting threshold into a prescription change. */
const quantityComparison = (plannedQuantity, actualQuantity, allowedVariancePct) => {
    if (actualQuantity == null || plannedQuantity == null || allowedVariancePct == null) return null;
    const planned = new Prisma.Decimal(plannedQuantity);
    const actual = new Prisma.Decimal(actualQuantity);
    const threshold = new Prisma.Decimal(allowedVariancePct);
    if (!planned.isFinite() || !planned.gt(0) || !actual.isFinite() || !actual.gt(0)
        || !threshold.isFinite() || threshold.lt(0) || threshold.gt(100)) return null;
    const difference = actual.minus(planned);
    // Compare products before division so rounding cannot change a boundary decision.
    return { difference: difference.toString(), percentage: difference.abs().div(planned).times(100).toString(),
        deviated: !difference.isZero(), exceedsThreshold: difference.abs().times(100).gt(planned.times(threshold)) };
};

const timingComparison = (schedule, dueAtMinutes, now = new Date()) => {
    const scheduledAt = new Date(schedule.scheduledAt);
    if (!Number.isInteger(dueAtMinutes) || dueAtMinutes < 0 || !Number.isFinite(scheduledAt.getTime())) {
        return { status: TIMING.UNKNOWN, dueAt: null };
    }
    const dueAt = new Date(scheduledAt.getTime() + dueAtMinutes * MINUTE_MS);
    const executedAt = schedule.execution?.executedAt && new Date(schedule.execution.executedAt);
    if (executedAt) {
        if (!Number.isFinite(executedAt.getTime())) return { status: TIMING.UNKNOWN, dueAt };
        return { status: executedAt < scheduledAt ? TIMING.EARLY : executedAt > dueAt ? TIMING.LATE : TIMING.ON_TIME,
            dueAt, differenceMinutes: (executedAt.getTime() - scheduledAt.getTime()) / MINUTE_MS };
    }
    return { dueAt, status: schedule.status === 'CANCELLED' ? TIMING.CANCELLED
        : schedule.status === 'COMPLETED' ? TIMING.UNKNOWN : now > dueAt ? TIMING.OVERDUE : TIMING.PENDING };
};

/** This projection is returned with protocol detail, not fetched by a separate execution endpoint. */
const executionRows = (protocol, schedules, now = new Date()) => {
    const items = new Map(protocol.items.map(item => [item.id, item]));
    return schedules.map(schedule => {
        const item = items.get(schedule.protocolItemId);
        if (!item) throw new Error('Schedule does not belong to the selected protocol.');
        const execution = schedule.execution;
        return { id: schedule.id, protocolItemId: item.id, operationType: schedule.operationType,
            scheduledAt: schedule.scheduledAt, status: schedule.status,
            plannedQuantity: String(schedule.plannedQuantity), unit: schedule.unit,
            plannedProduct: item.materialSnapshot ? { id: item.productId, name: item.materialSnapshot.name }
                : item.product ? { id: item.productId, name: item.product.name } : { id: item.productId, name: item.recommendedProductName },
            doseBasis: schedule.doseBasisSnapshot, doseValue: schedule.doseValueSnapshot == null ? null : String(schedule.doseValueSnapshot),
            basisQuantity: schedule.basisQuantity == null ? null : String(schedule.basisQuantity), basisUnit: schedule.basisUnit,
            sourceHealthLogId: schedule.sourceHealthLogId, calculatedAt: schedule.calculatedAt,
            sourceHealthLog: schedule.sourceHealthLog ? { ...schedule.sourceHealthLog,
                estimatedBiomassKg: String(schedule.sourceHealthLog.estimatedBiomassKg) } : null,
            mealNumber: item.mealNumber,
            cancellationReason: schedule.cancellationReason, cancellationType: schedule.cancellationType,
            cancelledAt: schedule.cancelledAt, instructions: item.instructions,
            actualQuantity: execution ? String(execution.actualQuantity) : null,
            actualProduct: execution?.actualProduct ? { id: execution.actualProductId, name: execution.actualProduct.name } : null,
            executor: execution?.executor ? { id: execution.executedBy, fullName: execution.executor.fullName } : null,
            executedAt: execution?.executedAt ?? null, recordedAt: execution?.createdAt ?? null,
            varianceReason: execution?.varianceReason ?? null, note: execution?.note ?? null,
            quantityComparison: quantityComparison(schedule.plannedQuantity, execution?.actualQuantity, protocol.allowedVariancePct),
            timing: timingComparison(schedule, item.dueAtMinutes, now) };
    });
};

module.exports = { TIMING, quantityComparison, timingComparison, executionRows };
