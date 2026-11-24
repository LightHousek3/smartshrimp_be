const { ApiError } = require('../utils');
const { messages } = require('../constants');
const {
    courseCoverage,
    cultureDay,
    courseEndsAt,
    nextOccurrences,
} = require('../utils/protocolTimeline');
const scheduleRules = require('../utils/productionSchedule');
const config = require('../config');
const { assertTreatmentCourse } = require('../utils/treatmentProtocolPolicy');
const {
    materialSelect,
    assertOperationalMaterial,
    assertApprovedMaterial,
} = require('./productionProtocolReview.service');
const jobNotices = require('../utils/jobNotification');

const OPEN_CASES = ['OPEN', 'MONITORING', 'IN_TREATMENT'];
const isActivationProduction = async (tx, protocolId, activatedAt) =>
    Boolean(activatedAt && await tx.protocolStatusHistory.count({
        where: { protocolId, eventType: 'ACTIVATED', fromStatus: 'APPROVED',
            toStatus: 'ACTIVE', changedAt: activatedAt },
    }));

/**
 * Write a protocol transition to its audit history inside the caller's transaction.
 */
const event = (tx, protocol, status, eventType, changedBy, reason, eventData, at = new Date()) =>
    tx.protocolStatusHistory.create({
        data: {
            protocolId: protocol.id,
            fromStatus: protocol.status,
            toStatus: status,
            eventType,
            changedBy,
            reason,
            eventData,
            changedAt: at,
        },
    });
/** Update the expected state and its audit event in the caller's transaction. */
const transition = async (
    tx,
    protocol,
    status,
    eventType,
    changedBy,
    reason,
    eventData = {},
    at = new Date(),
) => {
    const result = await tx.protocol.updateMany({
        where: { id: protocol.id, status: protocol.status },
        data: {
            status,
            updatedAt: at,
            ...(protocol.status === 'REJECTED' &&
                status !== 'REJECTED' && { rejectionReason: null }),
            ...(status === 'SUPERSEDED' && { supersededAt: at }),
            ...(status === 'ABORTED' && {
                abortReason: reason,
                abortedBy: changedBy,
                abortedAt: at,
            }),
        },
    });
    if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    await event(
        tx,
        protocol,
        status,
        eventType,
        changedBy,
        reason,
        protocol.rejectionReason
            ? { ...eventData, previousRejectionReason: protocol.rejectionReason }
            : eventData,
        at,
    );
};
/** Cancel only unexecuted planned slots, preserving recorded usage and earlier cancellations. */
const cancelPlanned = (tx, protocolId, cancellationType, reason, actorId, at) =>
    tx.operationSchedule.updateMany({
        where: { protocolItem: { protocolId }, status: 'PLANNED', execution: null },
        data: {
            status: 'CANCELLED',
            cancellationType,
            cancellationReason: reason,
            cancelledBy: actorId,
            cancelledAt: at,
            updatedAt: at,
        },
    });

/** Keep suspensions effective across protocol versions until their recorded IDs are released. */
const activeHolds = async (tx, seasonId) => {
    const events = await tx.protocolStatusHistory.findMany({
        where: { protocol: { seasonId }, eventType: { in: ['HOLD_SET', 'HOLD_RELEASED'] } },
        orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    });
    const released = new Set(
        events
            .filter((row) => row.eventType === 'HOLD_RELEASED')
            .flatMap((row) => row.eventData?.holdIds ?? []),
    );
    return events.filter((row) => row.eventType === 'HOLD_SET' && !released.has(row.id));
};
/** Record a suspension independently of the protocol status so replacement versions inherit it. */
const hold = (tx, protocol, actorId, reason, at, extra = {}) =>
    event(tx, protocol, protocol.status, 'HOLD_SET', actorId, reason, extra, at);
/** Release only the supplied suspension IDs; unrelated holds must remain effective. */
const release = (tx, protocol, actorId, reason, holds, at) =>
    holds.length
        ? event(
              tx,
              protocol,
              protocol.status,
              'HOLD_RELEASED',
              actorId,
              reason,
              { holdIds: holds.map((row) => row.id) },
              at,
          )
        : null;

/** Expose suspension state even when no current production version carries PAUSED. */
const productionPaused = async (tx, seasonId, holds) =>
    (holds ?? (await activeHolds(tx, seasonId))).length > 0 ||
    Boolean(
        await tx.protocol.count({
            where: { seasonId, protocolType: 'PRODUCTION', status: 'PAUSED' },
        }),
    );

/** Block production for unresolved suspensions or treatment whose effective start has arrived. */
const productionBlocked = async (tx, seasonId, at = new Date()) => {
    if ((await activeHolds(tx, seasonId)).length) return true;
    if (
        await tx.protocol.findFirst({
            where: { seasonId, protocolType: 'TREATMENT', status: 'ACTIVE' },
            select: { id: true },
        })
    )
        return true;
    const start = await nextTreatmentStart(tx, seasonId);
    return Boolean(start && start <= at);
};

/** A published replacement bounds old executions even while stock locks or a worker are delayed. */
const nextTreatmentStart = async (tx, seasonId, protocolId) => {
    const next = await tx.protocol.findMany({
        where: {
            seasonId,
            ...(protocolId && { id: { not: protocolId } }),
            protocolType: 'TREATMENT',

            status: 'APPROVED',
            treatmentStartAt: { not: null },
            diseaseCase: { status: { in: OPEN_CASES } },
        },
        orderBy: [{ treatmentStartAt: 'asc' }, { versionNo: 'asc' }],
        include: {
            diseaseCase: true,
            season: { include: { pond: { include: { farm: true } } } },
            items: { include: { product: { select: materialSelect } } },
        },
    });
    for (const row of next) {
        if (await treatmentEligible(tx, row, row.season)) return row.treatmentStartAt;
    }
    return null;
};

/** Record a clinical state change only when the expected case state still matches. */
const changeCase = async (tx, diseaseCase, status, actorId, reason, at) => {
    if (diseaseCase.status === status) return;
    const result = await tx.diseaseCase.updateMany({
        where: { id: diseaseCase.id, status: diseaseCase.status },
        data: { status, updatedAt: at },
    });
    if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
    await tx.diseaseCaseStatusHistory.create({
        data: {
            caseId: diseaseCase.id,
            fromStatus: diseaseCase.status,
            toStatus: status,
            changedBy: actorId,
            reason,
            changedAt: at,
        },
    });
};

/** Recheck mutable dependencies; approval alone cannot keep an ineligible material operational. */
const eligibleItems = async (tx, protocol, season, items) => {
    if (!items.length) return false;
    try {
        if (protocol.protocolType === 'TREATMENT') assertTreatmentCourse(protocol, season);
        for (const item of items) {
            assertOperationalMaterial(
                item.product,
                item,
                season.pond.farmId,
                season.pond.farm.ownerId,
                { ...protocol, season },
            );
            assertApprovedMaterial(item.product, item.materialSnapshot);
        }
        return true;
    } catch (error) {
        if (error instanceof ApiError) return false;
        throw error;
    }
};

/** Recheck the assigned Expert and prescription before an approved treatment can take over. */
const treatmentEligible = async (tx, protocol, season) => {
    if (
        !protocol ||
        !OPEN_CASES.includes(protocol.diseaseCase.status) ||
        !(protocol.reviewedAt < protocol.treatmentStartAt)
    )
        return false;
    const assigned = await tx.seasonPersonnelAssignment.findFirst({
        where: {
            seasonId: season.id,
            accountId: protocol.diseaseCase.expertId,
            role: 'EXPERT',
            unassignedAt: null,
            account: {
                role: 'EXPERT',
                status: 'ACTIVE',
                managedByOwnerId: season.pond.farm.ownerId,
            },
        },
        select: { id: true },
    });
    return Boolean(assigned && (await eligibleItems(tx, protocol, season, protocol.items)));
};

/** Distinguish an exhausted production plan from missing inputs that still require correction. */
const productionReadiness = async (
    tx,
    seasonId,
    at,
    { ignoreHoldIds = [], calculate = false } = {},
) => {
    /**
     * Return a resume restriction with a reason code and both recovery options disabled by default.
     */
    const fail = (code, message, extra = {}) => ({
        canResume: false,
        canCloseWithoutProduction: false,
        code,
        message,
        ...extra,
    });
    const holds = await activeHolds(tx, seasonId);
    if (holds.some((row) => !ignoreHoldIds.includes(row.id)))
        return fail('INDEPENDENT_HOLD', messages.TREATMENT_PROTOCOL.CARE_INDEPENDENT_HOLD);
    const running = await tx.protocol.findFirst({
        where: { seasonId, protocolType: 'TREATMENT', status: 'ACTIVE' },
        select: { id: true },
    });
    if (running) return fail('TREATMENT_RUNNING', messages.DISEASE_CASE.PROTOCOL_RUNNING_BLOCK);
    const season = await tx.aquacultureSeason.findUnique({
        where: { id: seasonId },
        include: { pond: { include: { farm: true } } },
    });
    if (
        season?.status !== 'ACTIVE' ||
        season.pond.farm.status !== 'ACTIVE' ||
        !season.stockingDate ||
        cultureDay(season.stockingDate, at) < 1
    ) {
        return fail('SEASON_NOT_READY', messages.DISEASE_CASE.CASE_OR_ROLE_CONFLICT);
    }
    const protocol = await tx.protocol.findFirst({
        where: {
            seasonId,
            protocolType: 'PRODUCTION',
            status: { in: ['APPROVED', 'PAUSED', 'ACTIVE'] },
        },
        orderBy: { versionNo: 'desc' },
        include: { items: { include: { product: { select: materialSelect } } } },
    });
    if (!protocol) {
        const latest = await tx.protocol.findFirst({
            where: { seasonId, protocolType: 'PRODUCTION' },
            orderBy: { versionNo: 'desc' },
            include: { items: true },
        });
        const end = latest && courseEndsAt({ ...latest, season });
        if (end && end < at)
            return fail(
                'NO_FUTURE_OCCURRENCE',
                messages.TREATMENT_PROTOCOL.CARE_PRODUCTION_EXPIRED(end),
                { canCloseWithoutProduction: true, protocolId: latest.id, effectiveEndAt: end },
            );
        const pending = latest && ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(latest.status);
        return fail(
            pending ? 'AWAITING_APPROVAL' : 'NO_PROTOCOL',
            pending
                ? messages.TREATMENT_PROTOCOL.CARE_PRODUCTION_UNAPPROVED
                : messages.TREATMENT_PROTOCOL.CARE_NO_PRODUCTION,
            { canCloseWithoutProduction: true },
        );
    }
    const rows = nextOccurrences({ ...protocol, season }, at);
    if (!rows.length)
        return fail('NO_FUTURE_OCCURRENCE', messages.TREATMENT_PROTOCOL.CARE_PRODUCTION_ENDED, {
            canCloseWithoutProduction: true,
            protocolId: protocol.id,
            effectiveEndAt: courseEndsAt({ ...protocol, season }),
        });
    if (
        !(await eligibleItems(
            tx,
            protocol,
            season,
            rows.map((row) => row.item),
        ))
    ) {
        return fail('INVALID_MATERIAL', messages.TREATMENT_PROTOCOL.CARE_PRODUCTION_INVALID, {
            protocolId: protocol.id,
        });
    }
    if (
        await tx.protocol.count({
            where: {
                seasonId,
                protocolType: 'TREATMENT',
                status: 'APPROVED',
                treatmentStartAt: { lte: at },
                diseaseCase: { status: { in: OPEN_CASES } },
            },
        })
    ) {
        return fail('TREATMENT_DUE', messages.TREATMENT_PROTOCOL.CARE_TREATMENT_DUE);
    }
    if (calculate) {
        const healthLogs = await tx.shrimpHealthLog.findMany({
            where: {
                seasonId,
                isVoided: false,
                recordedAt: {
                    lte: at,
                    gte: new Date(
                        at.getTime() - config.productionProtocol.biomassMaxAgeHours * 3600000,
                    ),
                },
            },
            orderBy: [{ recordedAt: 'desc' }, { id: 'asc' }],
        });
        const latestHarvestAt = await require('./harvest.service').latestHarvestAt(
            tx,
            seasonId,
            at,
        );
        for (const row of rows.filter(
            (row) =>
                scheduleRules.dateInVietnam(row.scheduledAt) ===
                scheduleRules.dateInVietnam(rows[0].scheduledAt),
        )) {
            const result = scheduleRules.calculate(row.item, row.doc, row.scheduledAt, {
                volumeM3: season.pond.volumeM3,
                healthLogs,
                now: at,
                biomassMaxAgeHours: config.productionProtocol.biomassMaxAgeHours,
                latestHarvestAt,
            });
            if (result.blocked)
                return fail(
                    result.blocked,
                    result.blocked === 'BIOMASS_MISSING_OR_STALE'
                        ? messages.TREATMENT_PROTOCOL.CARE_BIOMASS_REQUIRED
                        : messages.TREATMENT_PROTOCOL.CARE_CALCULATION_INVALID,
                    { protocolId: protocol.id },
                );
        }
    }
    return {
        canResume: true,
        canCloseWithoutProduction: false,
        code: 'READY',
        protocolId: protocol.id,
        protocolTitle: protocol.title,
        versionNo: protocol.versionNo,
        protocolUpdatedAt: protocol.updatedAt,
        nextScheduledAt: rows[0].scheduledAt,
        protocol,
        season,
    };
};

/** Activate the eligible production version only after all suspension and treatment guards pass. */
const resumeProduction = async (tx, seasonId, at) => {
    if (await productionBlocked(tx, seasonId, at)) return;
    if (await tx.protocol.count({ where: { seasonId, status: 'ACTIVE' } })) return;
    const readiness = await productionReadiness(tx, seasonId, at);
    if (!readiness.canResume) return readiness;
    const { protocol } = readiness;
    const previous = await tx.protocol.findMany({
        where: { seasonId, protocolType: 'PRODUCTION', id: { not: protocol.id }, status: 'PAUSED' },
    });
    for (const row of previous) {
        await transition(
            tx,
            row,
            'SUPERSEDED',
            'SUPERSEDED',
            null,
            'Bản nuôi mới tiếp quản.',
            {},
            at,
        );
        await cancelPlanned(tx, row.id, 'PROTOCOL_SUPERSEDED', 'Bản nuôi mới tiếp quản.', null, at);
    }
    await transition(
        tx,
        protocol,
        'ACTIVE',
        'ACTIVATED',
        null,
        'Phác đồ nuôi có hiệu lực theo DOC hiện tại.',
        {},
        at,
    );
    return readiness;
};

/** Suspend material schedules while retaining every recorded execution and cancellation. */
const pauseProduction = async (tx, seasonId, at) => {
    const rows = await tx.protocol.findMany({
        where: { seasonId, protocolType: 'PRODUCTION', status: 'ACTIVE' },
    });
    for (const row of rows) {
        await transition(
            tx,
            row,
            'PAUSED',
            'STATUS_CHANGED',
            null,
            'Tạm hoãn phác đồ nuôi theo quyết định chăm sóc ca bệnh.',
            {},
            at,
        );
        await cancelPlanned(
            tx,
            row.id,
            'TREATMENT_OVERRIDE',
            'Tạm hoãn lịch vật tư theo quyết định chăm sóc ca bệnh.',
            null,
            at,
        );
    }
};

/**
 * Collect the owner and current active assignees whose account roles still match their assignments.
 */
const participants = async (tx, season) => {
    const personnel = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId: season.id,
            role: { in: ['EXPERT', 'TECHNICIAN'] },
            unassignedAt: null,
            account: { status: 'ACTIVE', managedByOwnerId: season.pond.farm.ownerId },
        },
        select: { accountId: true, role: true, account: { select: { role: true } } },
    });
    return new Set([
        season.pond.farm.ownerId,
        ...personnel.filter((row) => row.account.role === row.role).map((row) => row.accountId),
    ]);
};

/** Persist completion notices for current participants; callers deliver them after commit. */
const notifyCourseEnd = async (tx, protocol, season, notices, at) => {
    const treatment = protocol.protocolType === 'TREATMENT';
    const next =
        treatment &&
        (await tx.protocol.findFirst({
            where: {
                diseaseCaseId: protocol.diseaseCaseId,
                id: { not: protocol.id },
                status: 'APPROVED',
            },
            include: {
                diseaseCase: true,
                items: { include: { product: { select: materialSelect } } },
            },
        }));
    const continuation =
        next &&
        courseEndsAt({ ...next, season }) > at &&
        (await treatmentEligible(tx, next, season));
    for (const accountId of await participants(tx, season)) {
        const notification = await tx.notification.create({
            data: {
                accountId,
                referenceType: treatment ? 'disease_case' : 'protocol',
                referenceId: treatment ? protocol.diseaseCaseId : protocol.id,
                type: 'SYSTEM',
                title:
                    protocol.status === 'APPROVED'
                        ? 'Kế hoạch chưa áp dụng đã hết thời gian'
                        : 'Phác đồ đã hoàn thành thời gian áp dụng',
                content: `${protocol.title}: ${
                    treatment
                        ? continuation
                            ? 'Đã có đợt điều trị tiếp theo được duyệt; áp dụng theo mốc chuyên gia đã đặt.'
                            : 'Chuyên gia cần quyết định chăm sóc tiếp theo. Phác đồ nuôi đang tạm hoãn.'
                        : 'Không tự kéo dài lịch vận hành.'
                }`,
            },
        });
        notices.push({
            accountId,
            id: notification.id,
            referenceType: notification.referenceType,
            referenceId: notification.referenceId,
        });
    }
};

/**
 * Complete the elapsed course and lock its remaining slots without declaring recovery or adherence.
 * Treatment moves the case to MONITORING and keeps production suspended for the Expert's next decision.
 */
const finishCourse = async (tx, protocol, season, at, end, notices) => {
    const schedules = await tx.operationSchedule.findMany({
        where: { protocolItem: { protocolId: protocol.id } },
        include: { execution: true },
    });
    await transition(
        tx,
        protocol,
        'COMPLETED',
        'COURSE_ENDED',
        null,
        'Kết thúc thời gian áp dụng; không xác nhận mọi lần thực hiện đều đạt yêu cầu.',
        {
            effectiveEndAt: end.toISOString(),
            coverage: courseCoverage({ ...protocol, season }, schedules, at),
        },
        at,
    );
    await cancelPlanned(
        tx,
        protocol.id,
        'PROTOCOL_COMPLETED',
        'Chưa ghi nhận; lịch đã khóa do phác đồ kết thúc.',
        null,
        at,
    );
    if (protocol.protocolType === 'TREATMENT') {
        if (protocol.diseaseCase.status !== 'RESOLVED')
            await changeCase(
                tx,
                protocol.diseaseCase,
                'MONITORING',
                null,
                'Kế hoạch điều trị đã kết thúc. Chờ Chuyên gia quyết định chăm sóc tiếp.',
                at,
            );
        await hold(
            tx,
            { ...protocol, status: 'COMPLETED' },
            null,
            'Chờ Chuyên gia quyết định sau điều trị.',
            at,
            { kind: 'AFTER_TREATMENT', diseaseCaseId: protocol.diseaseCaseId },
        );
    }
    await notifyCourseEnd(tx, protocol, season, notices, at);
};

/**
 * Reconcile elapsed courses, due treatment and production eligibility while the caller holds the season lock.
 * An eligible timely successor takes over without a monitoring gap; activation uses the Expert's anchor.
 * Return persisted notices for post-commit delivery rather than sending sockets inside the transaction.
 */
const reconcile = async (tx, seasonId, now = new Date()) => {
    const notices = [];
    const season = await tx.aquacultureSeason.findUnique({
        where: { id: seasonId },
        include: { pond: { include: { farm: true } } },
    });
    if (season?.status !== 'ACTIVE' || season.pond.farm.status !== 'ACTIVE' || !season.stockingDate)
        return notices;
    const due = await tx.protocol.findFirst({
        where: {
            seasonId,
            protocolType: 'TREATMENT',

            status: 'APPROVED',
            treatmentStartAt: { lte: now },
        },
        include: { diseaseCase: true, items: { include: { product: { select: materialSelect } } } },
        orderBy: [{ treatmentStartAt: 'asc' }, { versionNo: 'asc' }],
    });
    const dueEnd = due && courseEndsAt({ ...due, season });
    const canActivate =
        due && dueEnd && now <= dueEnd && (await treatmentEligible(tx, due, season));
    if (due && (!dueEnd || now <= dueEnd) && !canActivate) {
        for (const accountId of new Set(
            [season.pond.farm.ownerId, due.diseaseCase.expertId].filter(Boolean),
        )) {
            const saved = await jobNotices.save(
                tx,
                ['activation', due.id, scheduleRules.dateInVietnam(now)],
                {
                    accountId,
                    type: 'SCHEDULE_GENERATION_FAILED',
                    referenceType: 'aquaculture_season',
                    referenceId: season.id,
                    title: messages.JOBS.ACTIVATION_BLOCKED,
                    content: messages.JOBS.ACTIVATION_BLOCKED_CONTENT(due.title),
                    createdAt: now,
                },
            );
            if (saved) notices.push(saved);
        }
    }
    const running = await tx.protocol.findMany({
        where: { seasonId, status: { in: ['ACTIVE', 'PAUSED'] } },
        include: { items: true, diseaseCase: true },
    });
    for (const row of running) {
        const end = courseEndsAt({ ...row, season });
        const replacedInTime =
            canActivate && end && row.protocolType === 'TREATMENT' && due.treatmentStartAt <= end;
        // A timely replacement supersedes the old course without inserting a monitoring interval.
        if (end && now > end && !replacedInTime)
            await finishCourse(tx, row, season, now, end, notices);
    }
    const unusedProduction = await tx.protocol.findMany({
        where: { seasonId, protocolType: 'PRODUCTION', status: 'APPROVED' },
        include: { items: true },
    });
    for (const row of unusedProduction) {
        const end = courseEndsAt({ ...row, season });
        if (end && now > end) {
            await transition(
                tx,
                row,
                'CANCELLED',
                'PLAN_CANCELLED',
                null,
                'Kế hoạch nuôi chưa áp dụng đã qua toàn bộ thời gian chỉ định.',
                { effectiveEndAt: end.toISOString() },
                now,
            );
            await cancelPlanned(
                tx,
                row.id,
                'PROTOCOL_COMPLETED',
                'Khóa kế hoạch chưa áp dụng đã hết thời gian.',
                null,
                now,
            );
        }
    }
    if (due && dueEnd && now > dueEnd) {
        await transition(
            tx,
            due,
            'CANCELLED',
            'PLAN_CANCELLED',
            null,
            'Kế hoạch chưa áp dụng đã qua toàn bộ thời gian điều trị.',
            { effectiveEndAt: dueEnd.toISOString() },
            now,
        );
        await cancelPlanned(
            tx,
            due.id,
            'PROTOCOL_COMPLETED',
            'Khóa kế hoạch chưa áp dụng đã hết thời gian.',
            null,
            now,
        );
        await pauseProduction(tx, seasonId, now);
        await hold(
            tx,
            { ...due, status: 'CANCELLED' },
            null,
            'Kế hoạch không bắt đầu đúng thời gian. Cần Chuyên gia xử lý.',
            now,
            { kind: 'AFTER_TREATMENT', diseaseCaseId: due.diseaseCaseId },
        );
        await notifyCourseEnd(tx, due, season, notices, now);
    }
    if (canActivate) {
        const previous = await tx.protocol.findMany({ where: { seasonId, status: 'ACTIVE' } });
        for (const row of previous) {
            const production = row.protocolType === 'PRODUCTION';
            await transition(
                tx,
                row,
                production ? 'PAUSED' : 'SUPERSEDED',
                production ? 'STATUS_CHANGED' : 'SUPERSEDED',
                null,
                'Phác đồ điều trị đã duyệt bắt đầu có hiệu lực.',
                { replacementId: due.id },
                now,
            );
            await cancelPlanned(
                tx,
                row.id,
                production ? 'TREATMENT_OVERRIDE' : 'PROTOCOL_SUPERSEDED',
                'Lịch được thay bằng phác đồ điều trị có hiệu lực.',
                null,
                now,
            );
        }
        const waitingHolds = (await activeHolds(tx, seasonId)).filter(
            (row) =>
                row.eventData?.waitingForProtocolId === due.id ||
                (row.eventData?.kind === 'AFTER_TREATMENT' &&
                    row.eventData?.diseaseCaseId === due.diseaseCaseId),
        );
        await release(tx, due, null, 'Bản điều trị kế tiếp bắt đầu.', waitingHolds, now);
        await transition(
            tx,
            due,
            'ACTIVE',
            'ACTIVATED',
            null,
            'Tới mốc Chuyên gia chỉ định và đủ điều kiện.',
            { effectiveAt: due.treatmentStartAt.toISOString() },
            now,
        );
        const currentCase = await tx.diseaseCase.findUnique({ where: { id: due.diseaseCaseId } });
        await changeCase(
            tx,
            currentCase,
            'IN_TREATMENT',
            null,
            'Bắt đầu phác đồ điều trị đã duyệt.',
            now,
        );
        for (const accountId of await participants(tx, season)) {
            const saved = await jobNotices.save(tx, ['treatment-start', due.id], {
                accountId,
                type: 'TREATMENT_SCHEDULE_READY',
                referenceType: 'aquaculture_season',
                referenceId: seasonId,
                createdAt: now,
                title: 'Phác đồ điều trị bắt đầu có hiệu lực',
                content: `${due.title}: ca đang điều trị. Các cữ vật tư theo phác đồ nuôi được tạm hoãn; thực hiện theo lịch điều trị. Cữ thiếu căn cứ tính sẽ được báo riêng.`,
            });
            if (saved) notices.push(saved);
        }
    }
    await resumeProduction(tx, seasonId, now);
    return notices;
};

/**
 * Cancel an approved unapplied plan; abort a running course and move its case to MONITORING.
 * Apply the explicit production-care choice without clearing independent holds or resolving the case.
 * The authoring caller has already authorized the Expert and locked the season and protocol.
 */
const stop = async (
    tx,
    protocol,
    diseaseCase,
    actorId,
    { reason, resumeProduction: resume },
    at = new Date(),
) => {
    const waiting = protocol.status === 'APPROVED';
    if (protocol.status !== 'ACTIVE' && !waiting)
        throw ApiError.conflict(messages.TREATMENT_PROTOCOL.STATE);
    if (!reason?.trim() || typeof resume !== 'boolean')
        throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.REASON_REQUIRED);
    const status = waiting ? 'CANCELLED' : 'ABORTED';
    await transition(
        tx,
        protocol,
        status,
        waiting ? 'PLAN_CANCELLED' : 'ABORTED',
        actorId,
        reason.trim(),
        { resumeProduction: resume },
        at,
    );
    await cancelPlanned(tx, protocol.id, 'TREATMENT_ABORTED', reason.trim(), actorId, at);
    if (!waiting) await changeCase(tx, diseaseCase, 'MONITORING', actorId, reason.trim(), at);
    const stopped = { ...protocol, status };
    const automaticHolds = (await activeHolds(tx, protocol.seasonId)).filter(
        (row) => row.eventData?.waitingForProtocolId === protocol.id,
    );
    await release(tx, stopped, actorId, reason.trim(), automaticHolds, at);
    if (!resume) {
        await hold(tx, stopped, actorId, reason.trim(), at, {
            kind: 'EXPERT_CARE',
            diseaseCaseId: diseaseCase.id,
        });
        await pauseProduction(tx, protocol.seasonId, at);
        if (waiting && diseaseCase.status !== 'IN_TREATMENT')
            await changeCase(tx, diseaseCase, 'MONITORING', actorId, reason.trim(), at);
    }
    // A resume choice cannot erase an older independent hold.
    if (resume) await resumeProduction(tx, protocol.seasonId, at);
    await tx.diseaseCaseResponse.create({
        data: {
            caseId: diseaseCase.id,
            authorId: actorId,
            responseType: 'NORMAL',
            message: reason.trim(),
            attachments: [],
            createdAt: at,
        },
    });
    const season = await tx.aquacultureSeason.findUnique({
        where: { id: protocol.seasonId },
        select: { pond: { select: { farm: { select: { ownerId: true } } } } },
    });
    const technicians = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId: protocol.seasonId,
            role: 'TECHNICIAN',
            unassignedAt: null,
            account: {
                role: 'TECHNICIAN',
                status: 'ACTIVE',
                managedByOwnerId: season.pond.farm.ownerId,
            },
        },
        select: { accountId: true },
    });
    const recipients = new Set([
        season.pond.farm.ownerId,
        ...technicians.map((row) => row.accountId),
    ]);
    const notifications = [];
    for (const accountId of recipients) {
        const notification = await tx.notification.create({
            data: {
                accountId,
                title: 'Chuyên gia đã dừng phác đồ điều trị',
                content: `${protocol.title}: ${reason.trim()}`,
                type: 'TREATMENT_PROTOCOL_ABORTED',
                referenceType: 'disease_case',
                referenceId: diseaseCase.id,
            },
        });
        notifications.push({ accountId, id: notification.id });
    }
    return notifications;
};

/** Close operational plans and unresolved cases administratively without overwriting clinical conclusions. */
const closeSeason = async (tx, seasonId, ownerId, cancelled, at = new Date()) => {
    const reasonCode = cancelled ? 'SEASON_CANCELLED' : 'SEASON_ENDED';
    const reason = cancelled
        ? 'Khép ca theo lý do hành chính vì Chủ trại hủy vụ.'
        : 'Khép ca theo lý do hành chính vì Chủ trại kết thúc vụ.';
    const protocols = await tx.protocol.findMany({
        where: {
            seasonId,
            status: {
                in: ['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'PAUSED'],
            },
        },
    });
    for (const protocol of protocols) {
        const applied = ['ACTIVE', 'PAUSED'].includes(protocol.status);
        await transition(
            tx,
            protocol,
            applied ? 'COMPLETED' : 'CANCELLED',
            reasonCode,
            ownerId,
            reason,
            { reasonCode },
            at,
        );
        await cancelPlanned(
            tx,
            protocol.id,
            cancelled ? 'SEASON_CANCELLED' : 'SEASON_COMPLETED',
            reason,
            ownerId,
            at,
        );
    }
    const cases = await tx.diseaseCase.findMany({
        where: { seasonId, status: { not: 'RESOLVED' } },
    });
    for (const diseaseCase of cases) {
        const result = await tx.diseaseCase.updateMany({
            where: { id: diseaseCase.id, status: diseaseCase.status },
            data: {
                status: 'RESOLVED',
                resolutionReason: reasonCode,
                resolutionSummary: reason,
                resolvedBy: ownerId,
                resolvedAt: at,
                updatedAt: at,
            },
        });
        if (result.count !== 1) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
        await tx.diseaseCaseStatusHistory.create({
            data: {
                caseId: diseaseCase.id,
                fromStatus: diseaseCase.status,
                toStatus: 'RESOLVED',
                changedBy: ownerId,
                reason,
                changedAt: at,
            },
        });
    }
};

module.exports = {
    isActivationProduction,
    reconcile,
    stop,
    closeSeason,
    activeHolds,
    hold,
    release,
    resumeProduction,
    pauseProduction,
    transition,
    cancelPlanned,
    changeCase,
    productionBlocked,
    productionPaused,
    nextTreatmentStart,
    productionReadiness,
    treatmentEligible,
};
