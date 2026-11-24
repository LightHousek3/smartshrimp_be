const structure = require('./protocolStructure');
const { materialRevision } = require('./protocolMaterial');
const { PRODUCTION_PROTOCOL_LIMITS } = require('../constants');

const EVENT_LABELS = new Map([
    ['SUBMITTED', 'Gửi duyệt phác đồ'],
    ['HOLD_SET', 'Tạm hoãn phác đồ nuôi'],
    ['HOLD_RELEASED', 'Gỡ tạm hoãn phác đồ nuôi'],
    ['CARE_DECIDED', 'Quyết định chăm sóc'],
]);

const LEGACY_LIFECYCLE_REASONS = new Map([
    ['Tới mốc Expert chỉ định và đủ điều kiện.', 'Tới mốc Chuyên gia chỉ định và đủ điều kiện.'],
    ['Chờ Expert quyết định sau điều trị.', 'Chờ Chuyên gia quyết định sau điều trị.'],
    ['Kế hoạch điều trị đã kết thúc; chờ Expert quyết định chăm sóc tiếp.',
        'Kế hoạch điều trị đã kết thúc. Chờ Chuyên gia quyết định chăm sóc tiếp.'],
    ['Kế hoạch không bắt đầu đúng thời gian; cần Expert xử lý.',
        'Kế hoạch không bắt đầu đúng thời gian. Cần Chuyên gia xử lý.'],
    ['Khép do Owner hủy vụ, không phải kết luận khỏi bệnh.',
        'Khép ca theo lý do hành chính vì Chủ trại hủy vụ.'],
    ['Khép do Owner kết thúc vụ, không phải kết luận khỏi bệnh.',
        'Khép ca theo lý do hành chính vì Chủ trại kết thúc vụ.'],
]);

/** Translate known historical system messages without editing saved records. */
const lifecycleReason = (reason) => LEGACY_LIFECYCLE_REASONS.get(reason) ?? reason;

/** Label events that leave the protocol status unchanged. */
const presentProtocolHistory = (row) => {
    const { fromStatus, toStatus, eventType, changedBy } = row;
    const eventLabel = fromStatus === toStatus ? EVENT_LABELS.get(eventType) : null;
    let { reason } = row;
    if (eventType === 'PLAN_CANCELLED' && reason) {
        reason = reason.replace(/^Ca bệnh đã được Expert khép: /, 'Ca bệnh đã được Chuyên gia khép: ');
    } else if (!changedBy || ['SEASON_ENDED', 'SEASON_CANCELLED'].includes(eventType)) {
        reason = lifecycleReason(reason);
    }
    return { ...row, reason, ...(eventLabel && { eventLabel }) };
};

/** Serialize exact dose text and retain snapshot revisions when live catalog facts change. */
const wireItem = (entry) => ({
    ...(entry.recommendedProductDetails && {
        recommendedProductDetails: entry.recommendedProductDetails,
        recommendedManufacturerId: entry.recommendedManufacturerId ?? null,
    }),
    ...structure.itemMetadata(entry),
    id: entry.id,
    operationType: entry.operationType,
    productId: entry.productId,
    ...(entry.productId && {
        productRevision: materialRevision(entry.materialSnapshot ?? entry.product ?? {}),
    }),
    repeatIntervalDays: entry.repeatIntervalDays,
    doseBasis: entry.doseBasis,
    doseValue: String(entry.doseValue),
    doseUnit: entry.doseUnit,
    instructions: entry.instructions,
    dueAtMinutes: entry.dueAtMinutes ?? PRODUCTION_PROTOCOL_LIMITS.defaultDueAtMinutes,
    product: entry.product && {
        id: entry.product.id,
        name: entry.product.name,
        category: entry.product.category,
        unit: entry.product.unit,
        status: entry.product.status,
        materialRevision: materialRevision(entry.materialSnapshot ?? entry.product),
        needsReview: Boolean(
            entry.materialSnapshot &&
                materialRevision(entry.materialSnapshot) !== materialRevision(entry.product),
        ),
    },
});

/**
 * Present persisted stages with one-based day labels that distinguish production and treatment.
 */
const protocolStages = (row) =>
    structure.protocolGroups(row).map((stage) => ({
        ...stage,
        title: `${row.protocolType === 'TREATMENT' ? 'Ngày điều trị' : 'DOC'} ${stage.startDayOffset + 1}–${stage.endDayOffset + 1}`,
        meals: stage.meals.map((meal) => ({ ...meal, items: meal.items.map(wireItem) })),
    }));

module.exports = { wireItem, protocolStages, presentProtocolHistory, lifecycleReason };
