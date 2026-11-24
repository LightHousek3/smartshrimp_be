const { ApiError } = require('../utils');
const { messages } = require('../constants');
const lifecycle = require('./protocolLifecycle.service');
const { materialSelect, assertOperationalMaterial, assertApprovedMaterial } = require('./productionProtocolReview.service');
const { cultureDay, courseEndsAt, scheduledAtDay } = require('../utils/protocolTimeline');
const { occursOn } = require('../utils/protocolStructure');
const { calculate, dateInVietnam } = require('../utils/productionSchedule');
const { latestHarvestAt } = require('./harvest.service');
const config = require('../config');

const findPlan = async (tx, season, now) => {
    if (season.status !== 'ACTIVE' || !season.stockingDate ||
        !season.activatedAt || !season.activationDelayReason ||
        season.pond.farm.status !== 'ACTIVE') return null;
    const plan = await tx.protocol.findFirst({
        where: { seasonId: season.id, protocolType: 'PRODUCTION', status: 'ACTIVE' },
        include: { items: { include: { product: { select: materialSelect } } } },
    });
    if (!plan || !await lifecycle.isActivationProduction(tx, plan.id, season.activatedAt)) return null;
    const end = courseEndsAt({ ...plan, season });
    if (!end || now > end || await lifecycle.productionBlocked(tx, season.id, now)) return null;
    return { ...plan, season };
};

const calculateSlot = async (tx, plan, item, doc, at, now) => {
    const { season } = plan;
    assertOperationalMaterial(item.product, item, season.pond.farm.id, season.pond.farm.ownerId, plan);
    assertApprovedMaterial(item.product, item.materialSnapshot);
    const needsBiomass = ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(item.doseBasis);
    const maxAge = config.productionProtocol.biomassMaxAgeHours;
    const healthLogs = needsBiomass
        ? await tx.shrimpHealthLog.findMany({
              where: { seasonId: season.id, isVoided: false, createdAt: { lte: at },
                  recordedAt: { gte: new Date(at.getTime() - maxAge * 3600000), lte: at } },
          })
        : [];
    const calculation = calculate(item, doc, at, {
        volumeM3: season.pond.volumeM3, healthLogs, now, biomassMaxAgeHours: maxAge,
        latestHarvestAt: needsBiomass ? await latestHarvestAt(tx, season.id, at) : null,
    });
    if (calculation.blocked) throw ApiError.conflict(messages.OPERATION.HISTORICAL_FEED_BASIS);
    return {
        seasonId: season.id, protocolItemId: item.id, operationType: 'FEEDING',
        productId: item.productId, scheduledAt: at, ...calculation,
    };
};

const slotTime = (plan, item, doc) => {
    if (doc < 1 || item?.operationType !== 'FEEDING' || !occursOn(item, doc)) return null;
    const at = scheduledAtDay(plan, item, doc);
    return at && at < plan.season.activatedAt ? at : null;
};

const previews = async (tx, season, date, now) => {
    const plan = await findPlan(tx, season, now);
    if (!plan) return { enabled: false, rows: [] };
    if (!date || date > dateInVietnam(season.activatedAt)) return { enabled: true, rows: [] };
    const dateStart = new Date(`${date}T00:00:00+07:00`);
    const doc = cultureDay(season.stockingDate, dateStart);
    if (!(doc >= 1)) return { enabled: true, rows: [] };
    const saved = await tx.operationSchedule.findMany({
        where: { seasonId: season.id, protocolItem: { protocolId: plan.id },
            scheduledAt: { gte: dateStart, lt: new Date(dateStart.getTime() + 86400000) } },
        select: { protocolItemId: true, scheduledAt: true },
    });
    const identities = new Set(saved.map(row => `${row.protocolItemId}:${row.scheduledAt.getTime()}`));
    const rows = [];
    for (const item of plan.items) {
        const at = slotTime(plan, item, doc);
        if (!at || identities.has(`${item.id}:${at.getTime()}`)) continue;
        try {
            const slot = await calculateSlot(tx, plan, item, doc, at, now);
            const product = item.product;
            rows.push({
                id: item.id, ...slot, status: 'PLANNED',
                beforeActivation: true, activatedAt: season.activatedAt,
                product: { id: product.id, name: product.name, category: product.category,
                    unit: product.unit, imageUrls: product.imageUrls },
                protocolItem: {
                    id: item.id, productionMealId: item.productionMealId,
                    mealNumber: item.mealNumber, plannedTime: item.plannedTime,
                    dueAtMinutes: item.dueAtMinutes, instructions: item.instructions,
                    materialSnapshot: item.materialSnapshot,
                    protocol: { id: plan.id, title: plan.title, versionNo: plan.versionNo,
                        allowedVariancePct: plan.allowedVariancePct, protocolType: plan.protocolType },
                },
            });
        } catch (error) {
            if (!(error instanceof ApiError)) throw error;
        }
    }
    return { enabled: true, rows: rows.sort((a, b) => a.scheduledAt - b.scheduledAt) };
};

/** Resolve the same slot inside the recording transaction; the worker never creates these rows. */
const materialize = async (tx, seasonId, itemId, date, now) => {
    const season = await tx.aquacultureSeason.findUnique({
        where: { id: seasonId }, include: { pond: { include: { farm: true } } },
    });
    const plan = season && await findPlan(tx, season, now);
    if (!plan) throw ApiError.conflict(messages.OPERATION.HISTORICAL_FEED_UNAVAILABLE);
    const doc = cultureDay(season.stockingDate, date);
    const item = plan.items.find(row => row.id === itemId);
    const at = slotTime(plan, item, doc);
    if (!at || at.getTime() !== date.getTime())
        throw ApiError.conflict(messages.OPERATION.HISTORICAL_FEED_UNAVAILABLE);
    const saved = await tx.operationSchedule.findFirst({
        where: { seasonId, protocolItemId: itemId, scheduledAt: at },
        select: { id: true },
    });
    return saved ?? tx.operationSchedule.create({
        data: await calculateSlot(tx, plan, item, doc, at, now),
        select: { id: true },
    });
};

/** Validate the actual feeding day and the plan's state for use after activation. */
const assertRecordingTime = async (tx, schedule, executedAt) => {
    if (!executedAt || dateInVietnam(executedAt) !== dateInVietnam(schedule.scheduledAt)) {
        throw ApiError.badRequest(messages.OPERATION.HISTORICAL_FEED_TIME);
    }
    const { activatedAt } = schedule.season;
    if (executedAt < activatedAt) return;

    const state = await tx.protocolStatusHistory.findFirst({
        where: {
            protocolId: schedule.protocolItem.protocol.id,
            changedAt: { gte: activatedAt, lte: executedAt },
            OR: [
                { eventType: 'ACTIVATED', toStatus: 'ACTIVE' },
                { fromStatus: 'ACTIVE', toStatus: 'PAUSED' },
            ],
        },
        orderBy: [{ changedAt: 'desc' }, { toStatus: 'desc' }],
        select: { toStatus: true },
    });
    if (state?.toStatus !== 'ACTIVE') {
        throw ApiError.conflict(messages.OPERATION.HISTORICAL_FEED_PAUSED);
    }
};

module.exports = { previews, materialize, assertRecordingTime };
