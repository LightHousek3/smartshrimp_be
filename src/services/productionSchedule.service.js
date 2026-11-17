const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const config = require('../config');
const { protocolStructure: structure, productionSchedule: rules, ApiError } = require('../utils');
const {
    materialSelect,
    assertOperationalMaterial,
    assertApprovedMaterial,
} = require('./productionProtocolReview.service');
const { messages, PRODUCTION_PROTOCOL_LIMITS } = require('../constants');
const lifecycle = require('./protocolLifecycle.service');
const { treatmentOccurrences, courseEndsAt } = require('../utils/protocolTimeline');
const { latestHarvestAt } = require('./harvest.service');
const { assertCalculationStorage } = require('../utils/jobStorage');
const notices = require('../utils/jobNotification');
const biomassReminder = require('./biomassReminder.service');
const jobTransaction = require('../utils/jobTransaction');

const include = {
    season: { include: { pond: { include: { farm: true } } } },
    items: { include: { product: { select: materialSelect } }, orderBy: { sequenceOrder: 'asc' } },
};
const slotKey = (row) => `${row.protocolItemId ?? row.item.id}:${row.scheduledAt.toISOString()}`;
const sameCalculation = (row, calculated) =>
    ['unit', 'doseBasisSnapshot', 'basisUnit', 'sourceHealthLogId', 'calculationVersion'].every(
        (field) => (row[field] ?? null) === (calculated[field] ?? null),
    ) &&
    ['plannedQuantity', 'doseValueSnapshot', 'basisQuantity'].every((field) =>
        row[field] == null || calculated[field] == null
            ? row[field] == null && calculated[field] == null
            : new Prisma.Decimal(row[field]).equals(calculated[field]),
    );

/** Read calculation dependencies under the season lock, preserving past evidence for recovery. */
const readInputs = async (tx, protocol, now) => {
    const healthLogs = await tx.shrimpHealthLog.findMany({
        where: { seasonId: protocol.seasonId, isVoided: false, recordedAt: { lte: now } },
        orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    if (healthLogs.length)
        await tx.$queryRaw(Prisma.sql`SELECT id FROM shrimp_health_logs
        WHERE id IN (${Prisma.join(healthLogs.map((log) => Prisma.sql`${log.id}::uuid`))}) ORDER BY id FOR SHARE`);
    return healthLogs;
};

const notifyBlocked = async (tx, protocol, blocked, now, notifications) => {
    if (!blocked.size) return;
    const assignments = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId: protocol.seasonId,
            unassignedAt: null,
            role: { in: ['EXPERT', 'TECHNICIAN'] },
            account: { status: 'ACTIVE', managedByOwnerId: protocol.season.pond.farm.ownerId },
        },
        select: { accountId: true, role: true, account: { select: { role: true } } },
    });
    const recipients = new Set([
        protocol.season.pond.farm.ownerId,
        ...assignments
            .filter(
                (row) =>
                    row.role === row.account.role &&
                    !(
                        blocked.size === 1 &&
                        blocked.has('BIOMASS_MISSING_OR_STALE') &&
                        row.role === 'TECHNICIAN'
                    ),
            )
            .map((row) => row.accountId),
    ]);
    for (const accountId of recipients) {
        const saved = await notices.save(
            tx,
            ['generation', protocol.id, rules.dateInVietnam(now), [...blocked].sort()],
            {
                accountId,
                referenceId: protocol.seasonId,
                referenceType: 'aquaculture_season',
                type: 'SCHEDULE_GENERATION_FAILED',
                title: messages.PRODUCTION_PROTOCOL.SCHEDULE_FAILED,
                content: `${protocol.title}: ${messages.PRODUCTION_PROTOCOL.SCHEDULE_BLOCKED(
                    [...blocked]
                        .map((code) => messages.PRODUCTION_PROTOCOL.SCHEDULE_BLOCKERS[code] ?? code)
                        .join('; '),
                )}`,
                createdAt: now,
            },
        );
        if (saved) notifications.push(saved);
    }
};

/** Materialize or replace future slots atomically; recorded execution and cancellation remain facts. */
const materialize = async (target, requestedAt) => {
    const notifications = [];
    const result = await jobTransaction(
        async (tx) => {
            notifications.length = 0;
            const context = target.seasonId
                ? target
                : await tx.protocol.findUnique({
                      where: { id: target.protocolId },
                      select: { seasonId: true },
                  });
            if (!context) return { created: 0, blocked: [] };
            await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id=${context.seasonId}::uuid FOR UPDATE`;
            const now = requestedAt ?? new Date();
            notifications.push(...(await lifecycle.reconcile(tx, context.seasonId, now)));
            const protocol = target.protocolId
                ? await tx.protocol.findUnique({ where: { id: target.protocolId }, include })
                : await tx.protocol.findFirst({
                      where: { seasonId: context.seasonId, status: 'ACTIVE' },
                      include,
                  });
            if (!protocol || protocol.status !== 'ACTIVE') return { created: 0, blocked: [] };
            await tx.$queryRaw`SELECT id FROM protocols WHERE id=${protocol.id}::uuid FOR UPDATE`;
            const replacement = await lifecycle.nextTreatmentStart(
                tx,
                protocol.seasonId,
                protocol.id,
            );
            if (
                (replacement && now >= replacement) ||
                (protocol.protocolType === 'PRODUCTION' &&
                    (await lifecycle.productionBlocked(tx, protocol.seasonId, now)))
            )
                return { created: 0, blocked: ['TREATMENT_OVERRIDE'] };
            if (
                protocol.season.status !== 'ACTIVE' ||
                protocol.season.pond.farm.status !== 'ACTIVE' ||
                !protocol.season.stockingDate
            )
                return { created: 0, blocked: ['SEASON_NOT_READY'] };

            const occurrences =
                protocol.protocolType === 'TREATMENT'
                    ? treatmentOccurrences(protocol, now)
                    : rules.occurrences(protocol, now);
            const earliest = new Date(
                Math.min(now.getTime(), ...occurrences.map((row) => row.scheduledAt.getTime())),
            );
            const end = new Date(
                new Date(`${rules.dateInVietnam(now)}T00:00:00+07:00`).getTime() + 3 * 86400000,
            );
            const existing = await tx.operationSchedule.findMany({
                where: {
                    protocolItem: { protocolId: protocol.id },
                    scheduledAt: { gte: earliest, lt: end },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            const bySlot = new Map();
            for (const row of existing)
                bySlot.set(slotKey(row), [...(bySlot.get(slotKey(row)) ?? []), row]);
            const healthLogs = await readInputs(tx, protocol, now);
            const harvests = new Map(),
                blocked = new Set(),
                data = [];
            let cancelled = 0,
                storageChecked = false,
                firstMissingBiomassAt = null;
            const cancel = async (row) => {
                if (!storageChecked) {
                    await assertCalculationStorage(tx);
                    storageChecked = true;
                }
                const changed = await tx.operationSchedule.updateMany({
                    where: { id: row.id, status: 'PLANNED', execution: null },
                    data: {
                        status: 'CANCELLED',
                        cancellationType: 'CALCULATION_CHANGED',
                        cancelledAt: now,
                        cancelledBy: null,
                        cancellationReason: messages.JOBS.CALCULATION_CHANGED,
                        updatedAt: now,
                    },
                });
                if (changed.count !== 1)
                    throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
                cancelled++;
            };
            for (const { item, doc, cultureDay, scheduledAt } of occurrences) {
                const history = bySlot.get(slotKey({ item, scheduledAt })) ?? [];
                const live = history.find((row) => row.status !== 'CANCELLED');
                if (live && (live.status !== 'PLANNED' || scheduledAt <= now)) continue;
                if (
                    !live &&
                    history.length &&
                    (scheduledAt <= now ||
                        history.some(
                            (row) =>
                                row.cancellationType !== 'CALCULATION_CHANGED' &&
                                !(
                                    protocol.protocolType === 'PRODUCTION' &&
                                    row.cancellationType === 'TREATMENT_OVERRIDE'
                                ),
                        ))
                )
                    continue;
                structure.assertItemMetadata(item);
                let calculation;
                if (!item.materialSnapshot) calculation = { blocked: 'MATERIAL_UNRESOLVED' };
                try {
                    if (!calculation) {
                        assertOperationalMaterial(
                            item.product,
                            item,
                            protocol.season.pond.farmId,
                            protocol.season.pond.farm.ownerId,
                            protocol,
                        );
                        assertApprovedMaterial(item.product, item.materialSnapshot);
                    }
                } catch (error) {
                    if (!(error instanceof ApiError)) throw error;
                    calculation = { blocked: 'MATERIAL_INELIGIBLE' };
                }
                if (
                    !calculation &&
                    protocol.protocolType === 'TREATMENT' &&
                    cultureDay < 30 &&
                    ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(item.doseBasis)
                )
                    calculation = { blocked: 'DOSE_INVALID' };
                if (!calculation) {
                    const at = scheduledAt < now ? scheduledAt : now;
                    const key = at.toISOString();
                    if (!harvests.has(key))
                        harvests.set(key, await latestHarvestAt(tx, protocol.seasonId, at));
                    calculation = rules.calculate(item, doc, scheduledAt, {
                        volumeM3: protocol.season.pond.volumeM3,
                        healthLogs,
                        now,
                        biomassMaxAgeHours: config.productionProtocol.biomassMaxAgeHours,
                        latestHarvestAt: harvests.get(key),
                    });
                }
                if (calculation.blocked) {
                    blocked.add(calculation.blocked);
                    if (
                        calculation.blocked === 'BIOMASS_MISSING_OR_STALE' &&
                        (!firstMissingBiomassAt || scheduledAt < firstMissingBiomassAt)
                    )
                        firstMissingBiomassAt = scheduledAt;
                    if (live) await cancel(live);
                    continue;
                }
                if (live && sameCalculation(live, calculation)) continue;
                if (live) await cancel(live);
                data.push({
                    protocolItemId: item.id,
                    seasonId: protocol.seasonId,
                    operationType: item.operationType,
                    productId: item.productId,
                    scheduledAt,
                    ...calculation,
                });
            }
            const created = data.length
                ? (await tx.operationSchedule.createMany({ data, skipDuplicates: true })).count
                : 0;
            await notifyBlocked(tx, protocol, blocked, now, notifications);
            if (firstMissingBiomassAt)
                notifications.push(
                    ...(await biomassReminder.remind(
                        tx,
                        protocol,
                        healthLogs,
                        firstMissingBiomassAt,
                        await latestHarvestAt(tx, protocol.seasonId, now),
                        now,
                    )),
                );
            return { created, cancelled, blocked: [...blocked] };
        },
        { timeout: config.productionProtocol.transactionTimeoutMs },
    );
    notices.deliver(notifications);
    return result;
};

const generate = (protocolId, at) => materialize({ protocolId }, at);
const reconcileSeason = (seasonId, at) => materialize({ seasonId }, at);

/** Read full-course deadlines, never just dates already materialized in the rolling window. */
const batch = async (afterId) => {
    const rows = await prisma.protocol.findMany({
        where: {
            status: { in: ['APPROVED', 'ACTIVE', 'PAUSED'] },

            season: { status: 'ACTIVE', pond: { farm: { status: 'ACTIVE' } } },
            ...(afterId && { id: { gt: afterId } }),
        },
        select: {
            id: true,
            seasonId: true,
            protocolType: true,
            status: true,
            treatmentStartAt: true,
            season: { select: { stockingDate: true } },
            items: {
                select: {
                    startDayOffset: true,
                    endDayOffset: true,
                    recurrenceAnchorDay: true,
                    repeatIntervalDays: true,
                    plannedTime: true,
                    dueAtMinutes: true,
                },
            },
        },
        take: PRODUCTION_PROTOCOL_LIMITS.workerBatch,
        orderBy: { id: 'asc' },
    });
    const now = Date.now();
    return rows.map((row) => {
        const end = courseEndsAt(row);
        const times = [
            end && end.getTime() + 1,
            row.status === 'APPROVED' &&
                row.treatmentStartAt?.getTime() > now &&
                row.treatmentStartAt.getTime(),
        ].filter(Boolean);
        return {
            id: row.id,
            seasonId: row.seasonId,
            nextCheckAt: times.length ? Math.min(...times) : null,
        };
    });
};

module.exports = { generate, reconcileSeason, batch };
