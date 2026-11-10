const prisma = require('../config/prisma');
const config = require('../config');
const logger = require('../config/logger');
const { emitNotification } = require('../realtime/notification.socket');
const { productionProtocolV2: v2, productionSchedule: rules, ApiError } = require('../utils');
const { materialSelect, assertOperationalMaterial, assertApprovedMaterial } = require('./productionProtocolReview.service');
const { FARM_STATUS, NOTIFICATION_TYPE, messages, PRODUCTION_PROTOCOL_LIMITS, PROTOCOL_STATUS, PROTOCOL_TYPE, SEASON_STATUS } = require('../constants');
const lifecycle = require('./protocolLifecycle.service');
const { treatmentOccurrences } = require('../utils/protocolTimeline');
const { latestHarvestAt } = require('./harvest.service');

/** Lock the season before its protocol, matching authoring/approval order; never rewrite existing facts. */
const generate = async (protocolId, now = new Date()) => {
    if (!v2.v2Enabled() || !config.productionProtocol.scheduleWorkerEnabled) return { created: 0, blocked: [] };
    const notices = [];
    const result = await prisma.$transaction(async client => {
        const context = await client.protocol.findUnique({ where: { id: protocolId }, select: { seasonId: true } });
        if (!context) return { created: 0, blocked: [] };
        await client.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${context.seasonId}::uuid FOR UPDATE`;
        await client.$queryRaw`SELECT id FROM protocols WHERE id=${protocolId}::uuid FOR UPDATE`;
        await lifecycle.reconcile(client, context.seasonId, now);
        const p = await client.protocol.findUnique({ where: { id: protocolId }, include: {
            season: { include: { pond: { include: { farm: true } } } },
            items: { include: { product: { select: materialSelect } }, orderBy: { sequenceOrder: 'asc' } },
        } });
        if (!p || p.status !== PROTOCOL_STATUS.ACTIVE || !v2.isV2(p)) return { created: 0, blocked: [] };
        if (p.season.status !== SEASON_STATUS.ACTIVE || p.season.pond.farm.status !== FARM_STATUS.ACTIVE || !p.season.stockingDate) {
            return { created: 0, blocked: ['SEASON_NOT_READY'] };
        }
        const harvestedAt = await latestHarvestAt(client, p.seasonId, now);
        const healthLogs = await client.shrimpHealthLog.findMany({ where: { seasonId: p.seasonId, isVoided: false,
            recordedAt: { lte: now, gte: new Date(now.getTime() - config.productionProtocol.biomassMaxAgeHours * 3600000) } },
        orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }] });
        // Serializable snapshots may predate a wait on the season lock; lock sources to detect intervening voids.
        for (const logId of healthLogs.map(log => log.id).sort()) {
            await client.$queryRaw`SELECT id FROM shrimp_health_logs WHERE id = ${logId}::uuid FOR SHARE`;
        }
        const end = new Date(new Date(`${rules.dateInVietnam(now)}T00:00:00+07:00`).getTime() + p.rollingWindowDays * 86400000);
        const existing = await client.operationSchedule.findMany({ where: { protocolItem: { protocolId }, scheduledAt: { gte: now, lt: end } },
            select: { protocolItemId: true, scheduledAt: true, status: true, cancellationType: true } });
        const retained = existing.filter(row => !(p.protocolType === PROTOCOL_TYPE.PRODUCTION
            && row.status === 'CANCELLED' && row.cancellationType === 'TREATMENT_OVERRIDE'));
        const keys = new Set(retained.map(row => `${row.protocolItemId}:${row.scheduledAt.toISOString()}`));
        const data = [], blocked = new Set();
        const occurrences = p.protocolType === PROTOCOL_TYPE.TREATMENT ? treatmentOccurrences(p, now) : rules.occurrences(p, now);
        for (const { item, doc, cultureDay, scheduledAt } of occurrences) {
            if (keys.has(`${item.id}:${scheduledAt.toISOString()}`)) continue;
            v2.assertItemMetadata(item);
            if (!item.materialSnapshot) { blocked.add('MATERIAL_UNRESOLVED'); continue; }
            try {
                assertOperationalMaterial(item.product, item, p.season.pond.farmId, p.season.pond.farm.ownerId, p);
                assertApprovedMaterial(item.product, item.materialSnapshot);
            }
            catch (error) { if (!(error instanceof ApiError)) throw error; blocked.add('MATERIAL_INELIGIBLE'); continue; }
            if (p.protocolType === PROTOCOL_TYPE.TREATMENT && cultureDay < 30
                && ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(item.doseBasis)) { blocked.add('DOSE_INVALID'); continue; }
            const result = rules.calculate(item, doc, scheduledAt, { volumeM3: p.season.pond.volumeM3,
                healthLogs, now, biomassMaxAgeHours: config.productionProtocol.biomassMaxAgeHours, latestHarvestAt: harvestedAt });
            if (result.blocked) { blocked.add(result.blocked); continue; }
            data.push({ protocolItemId: item.id, seasonId: p.seasonId, operationType: item.operationType,
                productId: item.productId, scheduledAt, ...result });
        }
        const created = data.length ? (await client.operationSchedule.createMany({ data, skipDuplicates: true })).count : 0;
        if (blocked.size) {
            const accountId = p.season.pond.farm.ownerId;
            const dayStart = new Date(`${rules.dateInVietnam(now)}T00:00:00+07:00`);
            const notice = await client.notification.findFirst({ where: { accountId, referenceId: protocolId,
                type: NOTIFICATION_TYPE.SCHEDULE_GENERATION_FAILED, createdAt: { gte: dayStart } }, select: { id: true } });
            if (!notice) {
                const saved = await client.notification.create({ data: { accountId, referenceId: protocolId,
                referenceType: 'protocol', type: NOTIFICATION_TYPE.SCHEDULE_GENERATION_FAILED,
                title: messages.PRODUCTION_PROTOCOL.SCHEDULE_FAILED,
                content: messages.PRODUCTION_PROTOCOL.SCHEDULE_BLOCKED([...blocked].map(code => messages.PRODUCTION_PROTOCOL.SCHEDULE_BLOCKERS[code]).join('; ')),
                }, select: { id: true } });
                notices.push({ accountId, id: saved.id });
            }
        }
        return { created, blocked: [...blocked] };
    }, { isolationLevel: 'Serializable', timeout: 20000 });
    for (const notice of notices) {
        try { emitNotification(notice.accountId, 'notification:new', { id: notice.id, referenceId: protocolId }); }
        catch (error) { logger.warn(messages.PRODUCTION_PROTOCOL.SCHEDULE_DELIVERY_ERROR(protocolId, rules.errorDetail(error))); }
    }
    return result;
};

// A cursor avoids starving later protocols when there are more than one batch of active seasons.
const batch = async (afterId) => {
    if (!v2.v2Enabled() || !config.productionProtocol.scheduleWorkerEnabled) return [];
    return prisma.protocol.findMany({ where: { status: { in: [PROTOCOL_STATUS.APPROVED, PROTOCOL_STATUS.ACTIVE, PROTOCOL_STATUS.PAUSED] },
        contentVersion: 2, season: { status: SEASON_STATUS.ACTIVE }, ...(afterId && { id: { gt: afterId } }) },
    select: { id: true }, take: PRODUCTION_PROTOCOL_LIMITS.workerBatch, orderBy: { id: 'asc' } });
};
module.exports = { generate, batch };
