const { Prisma } = require('@prisma/client');
const { lifecycleReason } = require('./protocolPresentation');

const TIMING = Object.freeze({
    ON_TIME: 'ON_TIME',
    EARLY: 'EARLY',
    LATE: 'LATE',
    PENDING: 'PENDING',
    NOT_RECORDED: 'NOT_RECORDED',
    OVERDUE: 'OVERDUE',
    CANCELLED: 'CANCELLED',
    UNKNOWN: 'UNKNOWN',
});
const MINUTE_MS = 60000;

/** A meal recurs at a specific instant within one protocol version. */
const operationOccurrenceKey = ({ protocolItem, protocolItemId, scheduledAt }) => {
    const { protocolId, productionMealId, mealNumber } = protocolItem;
    const identity = productionMealId ?? (mealNumber == null ? protocolItemId : `meal:${mealNumber}`);
    return `${protocolId}:${identity}:${scheduledAt.getTime()}`;
};

/** Match all rows belonging to an occurrence, including earlier schedule revisions. */
const operationOccurrenceWhere = ({ protocolItem, protocolItemId, scheduledAt }) => {
    const { protocolId, productionMealId, mealNumber } = protocolItem;
    if (productionMealId == null && mealNumber == null) return { scheduledAt, protocolItemId };
    return {
        scheduledAt,
        protocolItem: {
            protocolId,
            productionMealId: productionMealId ?? null,
            ...(productionMealId == null && { mealNumber }),
        },
    };
};

/** Derive both reports from the same set of eligible material rows. */
const summarizeOperationProgress = (schedules, now) => {
    const current = new Map();
    for (const row of schedules) {
        const key = `${row.protocolItemId}:${row.scheduledAt.getTime()}`;
        const previous = current.get(key);
        if (!previous || (previous.status === 'CANCELLED' &&
            (row.status !== 'CANCELLED' || (row.cancelledAt ?? 0) > (previous.cancelledAt ?? 0)))) {
            current.set(key, row);
        }
    }

    const groups = new Map();
    const materials = {};
    for (const row of current.values()) {
        const timing = timingComparison(row, row.protocolItem.dueAtMinutes, now);
        const key = operationOccurrenceKey(row);
        const group = groups.get(key) ?? { started: row.scheduledAt <= now };
        let bucket;
        if (row.status === 'COMPLETED' && group.started) {
            bucket = 'completed';
        } else if (!timing.dueAt) {
            continue;
        } else if (row.status === 'CANCELLED') {
            const closedCourse = row.cancellationType === 'PROTOCOL_COMPLETED';
            const cutoff = row.effectiveEndAt && row.effectiveEndAt < row.cancelledAt ? row.effectiveEndAt : row.cancelledAt;
            if (row.cancellationType !== 'CALCULATION_CHANGED' && cutoff &&
                (closedCourse ? timing.dueAt <= cutoff : timing.dueAt < cutoff)) {
                bucket = 'lockedUnrecorded';
            }
        } else if (row.status === 'PLANNED') {
            if (row.effectiveEndAt && row.scheduledAt > row.effectiveEndAt) continue;
            if (row.effectiveEndAt && now > row.effectiveEndAt) {
                if (timing.dueAt <= row.effectiveEndAt) bucket = 'lockedUnrecorded';
            } else {
                bucket = timing.status === TIMING.OVERDUE ? 'overdue' : 'waiting';
            }
        }
        if (!bucket) continue;
        group[bucket] = true;
        groups.set(key, group);
        if (row.operationType && group.started) {
            const type = row.operationType.toLowerCase();
            const material = materials[type] ?? { started: 0, completed: 0 };
            material.started++;
            if (bucket === 'completed') material.completed++;
            materials[type] = material;
        }
    }

    const progress = { started: 0, completed: 0, waiting: 0, overdue: 0, lockedUnrecorded: 0 };
    for (const group of groups.values()) {
        if (group.overdue) progress.overdue++;
        else if (group.waiting) progress.waiting++;
        else if (group.lockedUnrecorded) progress.lockedUnrecorded++;
        else if (group.completed) progress.completed++;
        else continue;
        if (group.started) progress.started++;
    }
    return { progress, materialProgress: materials };
};

/** Compare persisted schedule units; never turn a reporting threshold into a prescription change. */
const quantityComparison = (plannedQuantity, actualQuantity, allowedVariancePct) => {
    if (actualQuantity == null || plannedQuantity == null || allowedVariancePct == null)
        return null;
    const planned = new Prisma.Decimal(plannedQuantity);
    const actual = new Prisma.Decimal(actualQuantity);
    const threshold = new Prisma.Decimal(allowedVariancePct);
    if (
        !planned.isFinite() ||
        !planned.gt(0) ||
        !actual.isFinite() ||
        !actual.gt(0) ||
        !threshold.isFinite() ||
        threshold.lt(0) ||
        threshold.gt(100)
    )
        return null;
    const difference = actual.minus(planned);
    // Compare products before division so rounding cannot change a boundary decision.
    return {
        difference: difference.toString(),
        percentage: difference.abs().div(planned).times(100).toString(),
        deviated: !difference.isZero(),
        exceedsThreshold: difference.abs().times(100).gt(planned.times(threshold)),
    };
};

/** Material substitutions cannot be compared against the prescribed quantity. */
const quantityAudit = (protocol, schedule) => {
    const execution = schedule.execution;
    if (!execution || (execution.actualProductId != null && execution.actualProductId !== schedule.productId)) {
        return null;
    }
    return quantityComparison(schedule.plannedQuantity, execution.actualQuantity, protocol.allowedVariancePct ?? 10);
};

/**
 * Classify execution against planned time and its grace period, or report the current state of an
 * unexecuted schedule.
 */
const timingComparison = (schedule, dueAtMinutes, now = new Date()) => {
    if (schedule.scheduledAt == null) return { status: TIMING.UNKNOWN, dueAt: null };
    const scheduledAt = new Date(schedule.scheduledAt);
    if (
        !Number.isInteger(dueAtMinutes) ||
        dueAtMinutes < 0 ||
        !Number.isFinite(scheduledAt.getTime())
    ) {
        return { status: TIMING.UNKNOWN, dueAt: null };
    }
    const dueAt = new Date(scheduledAt.getTime() + dueAtMinutes * MINUTE_MS);
    const executedAt = schedule.execution?.executedAt && new Date(schedule.execution.executedAt);
    if (executedAt) {
        if (!Number.isFinite(executedAt.getTime())) return { status: TIMING.UNKNOWN, dueAt };
        return {
            status:
                executedAt < scheduledAt
                    ? TIMING.EARLY
                    : executedAt > dueAt
                      ? TIMING.LATE
                      : TIMING.ON_TIME,
            dueAt,
            differenceMinutes: (executedAt.getTime() - scheduledAt.getTime()) / MINUTE_MS,
        };
    }
    if (schedule.status === 'CANCELLED') return { dueAt, status: TIMING.CANCELLED };
    if (schedule.status === 'NOT_RECORDED') return { dueAt, status: TIMING.NOT_RECORDED };
    if (schedule.status === 'COMPLETED') return { dueAt, status: TIMING.UNKNOWN };
    return { dueAt, status: now > dueAt ? TIMING.OVERDUE : TIMING.PENDING };
};

/** Keep execution facts and any replaced cancellation rows for the selected version. */
const executionRows = (protocol, schedules, now = new Date()) => {
    const items = new Map(protocol.items.map((item) => [item.id, item]));
    return schedules.map((schedule) => {
        const item = items.get(schedule.protocolItemId);
        if (!item) throw new Error('Schedule does not belong to the selected protocol.');
        const execution = schedule.execution;
        return {
            id: schedule.id,
            protocolItemId: item.id,
            operationType: schedule.operationType,
            scheduledAt: schedule.scheduledAt,
            status: schedule.status,
            plannedQuantity: schedule.plannedQuantity == null ? null : String(schedule.plannedQuantity),
            unit: schedule.unit,
            plannedProduct: item.materialSnapshot
                ? { id: item.productId, name: item.materialSnapshot.name }
                : item.product
                  ? { id: item.productId, name: item.product.name }
                  : {
                        id: item.productId,
                        name: item.recommendedProductDetails?.proposed?.name ?? 'Vật tư',
                    },
            doseBasis: schedule.doseBasisSnapshot,
            doseValue:
                schedule.doseValueSnapshot == null ? null : String(schedule.doseValueSnapshot),
            basisQuantity: schedule.basisQuantity == null ? null : String(schedule.basisQuantity),
            basisUnit: schedule.basisUnit,
            sourceHealthLogId: schedule.sourceHealthLogId,
            calculatedAt: schedule.calculatedAt,
            sourceHealthLog: schedule.sourceHealthLog
                ? {
                      ...schedule.sourceHealthLog,
                      estimatedBiomassKg: String(schedule.sourceHealthLog.estimatedBiomassKg),
                  }
                : null,
            mealNumber: item.mealNumber,
            productionMealId: item.productionMealId,
            productImageUrls: item.materialSnapshot?.imageUrls ?? item.product?.imageUrls ??
                item.recommendedProductDetails?.proposed?.imageUrls ?? [],
            cancellationReason: lifecycleReason(schedule.cancellationReason),
            cancellationType: schedule.cancellationType,
            cancelledAt: schedule.cancelledAt,
            cancelledByName: schedule.cancelledByAccount?.fullName ?? null,
            instructions: item.instructions,
            actualQuantity: execution ? String(execution.actualQuantity) : null,
            actualProduct: execution?.actualProduct
                ? { id: execution.actualProductId, name: execution.actualProduct.name }
                : null,
            executor: execution?.executor
                ? { id: execution.executedBy, fullName: execution.executor.fullName }
                : null,
            executedAt: execution?.executedAt ?? null,
            recordedAt: execution?.createdAt ?? null,
            varianceReason: execution?.varianceReason ?? null,
            note: execution?.note ?? null,
            quantityComparison: quantityAudit(protocol, schedule),
            timing: timingComparison(schedule, item.dueAtMinutes, now),
        };
    });
};

module.exports = {
    TIMING, quantityComparison, quantityAudit, timingComparison, executionRows,
    operationOccurrenceKey, operationOccurrenceWhere, summarizeOperationProgress,
};
