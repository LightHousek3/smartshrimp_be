const { Prisma, ProductionProtocolTemplateStatus: TemplateStatus } = require('@prisma/client');
const { createHash, randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const { wireItem, protocolStages, presentProtocolHistory } = require('../utils/protocolPresentation');
const { cultureDay, courseCoverage } = require('../utils/protocolTimeline');
const lifecycle = require('./protocolLifecycle.service');
const drafts = require('./protocolDraft.service');
const { executionRows } = require('../utils/protocolExecution');
const logger = require('../config/logger');
const config = require('../config');
const { emitNotification } = require('../realtime/notification.socket');
const {
    ApiError,
    protocolStructure: structure,
    assertMaterialSafety,
    assertTemplateDose,
    productFromRecommendation,
    assertProtocolHarvestCoverage,
    getMaterialSafety,
} = require('../utils');
const { hasOverlappingStages } = require('../utils/productionProtocol');
const {
    messages,
    FARM_STATUS,
    NOTIFICATION_TYPE,
    PRODUCTION_PROTOCOL_EDITABLE_STATUSES,
    PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES,
    PRODUCTION_PROTOCOL_WRITABLE_SEASONS,
    PRODUCTION_PROTOCOL_LIMITS,
    httpStatus,
} = require('../constants');

const {
    assertTreatmentStart,
    assertTreatmentFirstStage,
    assertTreatmentCourse,
} = require('../utils/treatmentProtocolPolicy');
const { materialRevision, assertMaterialRevision } = require('../utils/protocolMaterial');

/** Build shared authoring operations with protocol-specific scope, day rules and template policy. */
const createWorkflow = ({ protocolType = 'PRODUCTION', diseaseCaseId = null } = {}) => {
    const treatment = protocolType === 'TREATMENT';
    const PRODUCT_SELECT = {
        id: true,
        name: true,
        category: true,
        unit: true,
        conversionQuantity: true,
        conversionUnit: true,
        status: true,
        farmId: true,
        description: true,
        recommendationReason: true,
        imageUrls: true,
        manufacturerId: true,
        manufacturer: {
            select: {
                id: true,
                name: true,
                status: true,
                supplierType: true,
                ownerId: true,
                address: true,
                contactName: true,
                phone: true,
                email: true,
            },
        },
        compliance: true,
    };
    /**
     * Load protocol items in authoring order with the catalog fields needed by the editor.
     */
    const protocolInclude = () => ({
        items: {
            orderBy: { sequenceOrder: 'asc' },
            include: { product: { select: PRODUCT_SELECT } },
        },
    });

    /** Fail closed until the existing-table storage and its deferred integrity checks are installed. */
    const assertStorageReady = async (tx) => {
        const [result] = await tx.$queryRaw`SELECT
            (SELECT count(*) FROM (VALUES
                ('protocols','source_template_snapshot','jsonb',false),
                ('protocols','production_structure','jsonb',true),
                ('protocol_items','production_meal_id','uuid',false),
                ('protocol_items','daily_dose_increment','numeric(14,4)',false),
                ('protocol_items','recurrence_anchor_day','integer',false),
                ('protocol_items','dose_anchor_day','integer',false),
                ('protocol_items','material_snapshot','jsonb',false)
            ) wanted(table_name,column_name,type_name,not_null)
            JOIN pg_class c ON c.relname=wanted.table_name JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
            JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=wanted.column_name AND NOT a.attisdropped
            WHERE format_type(a.atttypid,a.atttypmod)=wanted.type_name AND a.attnotnull=wanted.not_null)=7
            AND (SELECT count(*) FROM pg_constraint WHERE convalidated AND contype='c' AND
                (conrelid='public.protocols'::regclass AND conname IN ('protocols_production_storage_check','protocols_template_source_check')
                 OR conrelid='public.protocol_items'::regclass AND conname IN ('protocol_items_production_metadata_check','protocol_items_production_dose_rule_check')))=4
            AND to_regprocedure('public.production_protocol_structure_valid(jsonb)') IS NOT NULL
            AND to_regprocedure('public.validate_production_protocol_storage()') IS NOT NULL
            AND (SELECT count(*) FROM pg_trigger WHERE tgenabled='O' AND tgdeferrable AND tginitdeferred AND
                (tgrelid='public.protocols'::regclass AND tgname='production_protocol_structure_check'
                 OR tgrelid='public.protocol_items'::regclass AND tgname='production_protocol_item_storage_check'))=2 AS ready`;
        if (!result?.ready)
            throw new ApiError(
                httpStatus.SERVICE_UNAVAILABLE,
                messages.PRODUCTION_PROTOCOL.SCHEMA_NOT_READY,
            );
    };
    /** Require an active farm and current assignment; treatment also needs an active season and unresolved case. */
    const isWritable = (season) =>
        (treatment
            ? season.status === 'ACTIVE' && season.diseaseCase?.status !== 'RESOLVED'
            : PRODUCTION_PROTOCOL_WRITABLE_SEASONS.includes(season.status)) &&
        season.currentAssignment &&
        season.pond.farm.status === FARM_STATUS.ACTIVE;
    const { isUnsubmittedDraft } = drafts;
    /** Surface stale revisions and concurrent database changes as protocol conflicts. */
    const mapError = (error) => {
        if (
            ['P2002', 'P2034', 'P2025', 'P2003', 'P2028'].includes(error.code) ||
            (error.code === 'P2010' && ['40001', '40P01', '55P03'].includes(error.meta?.code))
        ) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
        }
        throw error;
    };
    /**
     * Keep protocol content and status history atomic; surface concurrent writes as conflicts.
     */
    const transaction = async (callback) => {
        const notifications = [];
        try {
            const result = await prisma.$transaction((tx) => callback(tx, notifications), {
                isolationLevel: 'Serializable',
                maxWait: 5000,
                timeout: config.productionProtocol.transactionTimeoutMs,
            });
            // Persisted notifications remain readable even if realtime delivery is unavailable.
            for (const notification of notifications) {
                try {
                    emitNotification(notification.accountId, 'notification:new', {
                        id: notification.id,
                    });
                } catch (_) {
                    logger.warn('Protocol notification realtime delivery failed after commit.');
                }
            }
            return result;
        } catch (error) {
            return mapError(error);
        }
    };

    /**
     * Resolve the active expert's owner and assignment scope inside the caller's transaction.
     * Historical assignments allow reads of ended seasons; writes require a current assignment.
     */
    const scope = async (tx, accountId, seasonId, write = false) => {
        // Prisma has no row-lock API. Parameterized locks coordinate with existing UPDATE writers,
        // including account revocation and assignment replacement; all reads remain on this tx.
        if (write) {
            await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM aquaculture_seasons WHERE id = ${seasonId}::uuid FOR UPDATE`;
        }
        const account = await tx.account.findUnique({
            where: { id: accountId },
            select: {
                role: true,
                status: true,
                managedByOwnerId: true,
            },
        });
        if (!account || account.status !== 'ACTIVE' || account.role !== 'EXPERT') {
            throw ApiError.forbidden(messages.PRODUCTION_PROTOCOL.EXPERT_INACTIVE);
        }
        const season = await tx.aquacultureSeason.findUnique({
            where: { id: seasonId },
            select: {
                id: true,
                name: true,
                status: true,
                shrimpType: true,
                initialQuantity: true,
                stockingDate: true,
                expectedEndDate: true,
                actualEndDate: true,
                pond: {
                    select: {
                        id: true,
                        name: true,
                        volumeM3: true,
                        farm: {
                            select: {
                                id: true,
                                name: true,
                                ownerId: true,
                                status: true,
                            },
                        },
                    },
                },
            },
        });
        if (!season || season.pond.farm.ownerId !== account.managedByOwnerId) {
            throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
        }
        if (write) {
            const farmId = season.pond.farm.id;
            const pondId = season.pond.id;
            await tx.$queryRaw`SELECT id FROM farms WHERE id = ${farmId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM ponds WHERE id = ${pondId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM season_personnel_assignments
                WHERE season_id = ${seasonId}::uuid AND account_id = ${accountId}::uuid
                  AND role = 'expert' AND unassigned_at IS NULL FOR SHARE`;
            // Recheck the farm under the write locks before granting a mutation.
            const farm = await tx.farm.findFirst({
                where: { id: farmId, ownerId: account.managedByOwnerId },
                select: { status: true },
            });
            if (!farm) throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
            season.pond.farm.status = farm.status;
        }
        const assignments = await tx.seasonPersonnelAssignment.findMany({
            where: {
                seasonId,
                accountId,
                role: 'EXPERT',
            },
            select: { unassignedAt: true },
        });
        const currentAssignment = assignments.some((entry) => entry.unassignedAt === null);
        const historicalRead =
            ['COMPLETED', 'CANCELLED'].includes(season.status) && assignments.length > 0;
        if (!currentAssignment && !historicalRead) {
            throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
        }
        if (treatment) {
            season.diseaseCase = await tx.diseaseCase.findFirst({
                where: { id: diseaseCaseId, seasonId, expertId: accountId },
            });
            if (!season.diseaseCase) throw ApiError.notFound(messages.DISEASE_CASE.NOT_FOUND);
        }
        const result = {
            ...season,
            currentAssignment,
        };
        if (write && !isWritable(result)) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
        }
        return result;
    };
    /** Match the protocol type, season and parent case; an unrelated protocol ID never grants access. */
    const findProtocol = async (tx, seasonId, protocolId) => {
        const row = await tx.protocol.findFirst({
            where: {
                id: protocolId,
                seasonId,
                protocolType,
                diseaseCaseId,
            },
            include: protocolInclude(),
        });
        if (!row) {
            throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.NOT_FOUND);
        }
        return row;
    };
    /** Successors and generated schedules make protocol content immutable in this editor. */
    const blockers = async (tx, row) => {
        const [successor, schedules] = await Promise.all([
            tx.protocol.count({ where: { supersedesProtocolId: row.id } }),
            tx.operationSchedule.count({ where: { protocolItem: { protocolId: row.id } } }),
        ]);
        return successor > 0 || schedules > 0;
    };
    // The fixed UTC date carries a farm wall-clock TIME value without shifting its hour.
    const plannedTime = (value) =>
        value == null
            ? null
            : new Date(`1970-01-01T${value.length === 5 ? `${value}:00` : value}Z`);
    // Hash persisted content only; catalog labels/status can change independently.
    const revisionOf = (row) => {
        /**
         * Make missing fields explicit in the persisted-content revision input.
         */
        const project = (value, names) =>
            Object.fromEntries(names.map((name) => [name, value[name] ?? null]));
        /**
         * Normalize serialized values and object key order so equivalent content yields the same
         * revision.
         */
        const canonical = (value) => {
            if (value?.toJSON) return canonical(value.toJSON());
            if (Array.isArray(value)) return value.map(canonical);
            if (value && typeof value === 'object')
                return Object.fromEntries(
                    Object.keys(value)
                        .sort()
                        .map((key) => [key, canonical(value[key])]),
                );
            return value;
        };
        const header = project(row, [
            'id',
            'protocolType',
            'seasonId',
            'diseaseCaseId',
            'treatmentStartAt',
            'sourceTemplateId',
            'versionNo',
            'supersedesProtocolId',
            'title',
            'summary',
            'allowedVariancePct',
            'rollingWindowDays',
            'status',
            'createdBy',
            'submittedAt',
            'reviewedBy',
            'reviewedAt',
            'rejectionReason',
            'supersededAt',
            'abortReason',
            'abortedBy',
            'abortedAt',
            'createdAt',
            'updatedAt',
            'sourceTemplateSnapshot',
            'productionStructure',
        ]);
        const items = [...row.items]
            .sort((a, b) => a.sequenceOrder - b.sequenceOrder || a.id.localeCompare(b.id))
            .map((item) =>
                project(item, [
                    'id',
                    'protocolId',
                    'operationType',
                    'productId',
                    'recommendedProductDetails',
                    'recommendedManufacturerId',
                    'startDayOffset',
                    'endDayOffset',
                    'repeatIntervalDays',
                    'mealNumber',
                    'plannedTime',
                    'doseBasis',
                    'doseValue',
                    'doseUnit',
                    'instructions',
                    'sequenceOrder',
                    'createdAt',
                    'updatedAt',
                    'productionMealId',
                    'dailyDoseIncrement',
                    'recurrenceAnchorDay',
                    'doseAnchorDay',
                    'materialSnapshot',
                    'dueAtMinutes',
                ]),
            );
        return createHash('sha256')
            .update(JSON.stringify(canonical({ ...header, items })))
            .digest('hex');
    };
    /** Resolve audit actor names in bulk while retaining events recorded by the system. */
    const history = async (tx, protocolId) => {
        const rows = await tx.protocolStatusHistory.findMany({
            where: { protocolId },
            orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
        });
        const accounts = await tx.account.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.changedBy).filter(Boolean))] } },
            select: { id: true, fullName: true },
        });
        const names = new Map(accounts.map((account) => [account.id, account.fullName]));
        return rows.map((row) => ({
            ...presentProtocolHistory(row),
            changedByName: row.changedBy
                ? (names.get(row.changedBy) ?? 'Tài khoản cũ')
                : 'Hệ thống',
        }));
    };
    /** Persist the status transition and optional event payload on the caller's transaction. */
    const appendHistory = (
        tx,
        protocolId,
        fromStatus,
        toStatus,
        accountId,
        reason = null,
        eventType = 'STATUS_CHANGED',
        eventData,
    ) =>
        tx.protocolStatusHistory.create({
            data: {
                protocolId,
                fromStatus: fromStatus?.toUpperCase() ?? null,
                toStatus: toStatus.toUpperCase(),
                changedBy: accountId,
                reason,
                eventType,
                ...(eventData && { eventData: JSON.parse(JSON.stringify(eventData)) }),
            },
        });
    /** Copy editable fields without the saved item ID, product object or material snapshot. */
    const copyItem = (entry) => {
        const fields = wireItem(entry);
        delete fields.id;
        delete fields.product;
        delete fields.materialSnapshot;
        return fields;
    };
    /** Return the saved prescription with a content revision and actions allowed in its current scope. */
    const wireDetail = (row, season, blocked, statusHistory) => ({
        id: row.id,
        seasonId: row.seasonId,
        protocolType: row.protocolType,
        diseaseCaseId: row.diseaseCaseId,
        treatmentStartAt: row.treatmentStartAt,
        versionNo: row.versionNo,
        supersedesProtocolId: row.supersedesProtocolId,
        sourceTemplateSnapshot: row.sourceTemplateSnapshot ?? null,
        sourceTemplateId: row.sourceTemplateId,
        title: row.title,
        summary: row.summary,
        status: row.status,
        allowedVariancePct: row.allowedVariancePct == null ? null : String(row.allowedVariancePct),
        rollingWindowDays: row.rollingWindowDays,
        revision: revisionOf(row),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        submittedAt: row.submittedAt,
        reviewedAt: row.reviewedAt,
        reviewedBy: row.reviewedBy,
        rejectionReason: row.rejectionReason,
        stages: protocolStages(row),
        ungroupedItems: [],
        statusHistory,
        availableActions: {
            submit: Boolean(
                isWritable(season) &&
                PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) &&
                !blocked &&
                row.items.length,
            ),
            update: Boolean(
                isWritable(season) &&
                PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) &&
                !blocked,
            ),
            delete: Boolean(isWritable(season) && isUnsubmittedDraft(row) && !blocked),
            stop: Boolean(
                treatment && isWritable(season) && ['ACTIVE', 'APPROVED'].includes(row.status),
            ),
        },
    });
    /**
     * Get season context and creation eligibility without exposing the farm owner's account ID.
     */
    const getSeason = (accountId, seasonId) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const [approved, inProgress] = await Promise.all([
                tx.protocol.findFirst({
                    where: {
                        seasonId,
                        protocolType,
                        diseaseCaseId,
                        status: { in: ['APPROVED', 'ACTIVE', 'PAUSED'] },
                    },
                    select: {
                        id: true,
                        title: true,
                        versionNo: true,
                        reviewedAt: true,
                        status: true,
                    },
                    orderBy: { versionNo: 'desc' },
                }),
                tx.protocol.count({
                    where: {
                        seasonId,
                        protocolType,
                        diseaseCaseId,
                        status: { in: PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES },
                    },
                }),
            ]);
            const { currentAssignment, ...data } = season;
            return {
                ...data,
                initialQuantity: data.initialQuantity == null ? null : String(data.initialQuantity),
                pond: {
                    ...data.pond,
                    volumeM3: data.pond.volumeM3 == null ? null : String(data.pond.volumeM3),
                    farm: {
                        id: data.pond.farm.id,
                        name: data.pond.farm.name,
                    },
                },
                authoringVersion: 2,
                approvedProductionProtocol: approved,
                availableActions: {
                    create: Boolean(currentAssignment && isWritable(season) && !inProgress),
                },
            };
        });
    /**
     * List protocol versions with revision tokens and actions evaluated from current dependencies.
     */
    const list = (accountId, seasonId, { page = 1, limit = 20 } = {}) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const where = {
                seasonId,
                protocolType,
                diseaseCaseId,
            };
            const [totalResults, rows] = await Promise.all([
                tx.protocol.count({ where }),
                tx.protocol.findMany({
                    where,
                    orderBy: { versionNo: 'desc' },
                    skip: (page - 1) * limit,
                    take: limit,
                    include: protocolInclude(),
                }),
            ]);
            const data = await Promise.all(
                rows.map(async (row) => {
                    const blocked = await blockers(tx, row);
                    return {
                        id: row.id,
                        title: row.title,
                        versionNo: row.versionNo,
                        status: row.status,
                        revision: revisionOf(row),
                        updatedAt: row.updatedAt,
                        submittedAt: row.submittedAt,
                        reviewedAt: row.reviewedAt,
                        rejectionReason: row.rejectionReason,
                        stageCount: structure.protocolGroups(row).length,
                        itemCount: row.items.length,
                        availableActions: {
                            submit: Boolean(
                                isWritable(season) &&
                                PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) &&
                                !blocked &&
                                row.items.length,
                            ),
                            view: true,
                            update: Boolean(
                                isWritable(season) &&
                                PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(row.status) &&
                                !blocked,
                            ),
                            delete: Boolean(
                                isWritable(season) && isUnsubmittedDraft(row) && !blocked,
                            ),
                        },
                    };
                }),
            );
            return {
                data,
                meta: {
                    page,
                    limit,
                    totalResults,
                },
            };
        });
    /**
     * Read content, action eligibility and history in one authorized transaction.
     * Treatment details include execution rows and adherence counts for local client filtering.
     */
    const detail = (accountId, seasonId, protocolId) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const row = await findProtocol(tx, seasonId, protocolId);
            const data = wireDetail(
                row,
                season,
                await blockers(tx, row),
                await history(tx, row.id),
            );
            if (treatment) {
                const schedules = await tx.operationSchedule.findMany({
                    where: { protocolItem: { protocolId: row.id } },
                    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
                    include: {
                        execution: {
                            include: {
                                executor: { select: { id: true, fullName: true } },
                                actualProduct: { select: { id: true, name: true } },
                            },
                        },
                        sourceHealthLog: {
                            select: {
                                id: true,
                                recordedAt: true,
                                estimatedBiomassKg: true,
                                isVoided: true,
                            },
                        },
                    },
                });
                data.executionRows = executionRows(row, schedules);
                data.coverage = courseCoverage({ ...row, season }, schedules);
                data.asOf = new Date();
            }
            return data;
        });
    /** Only active products in the season's farm are eligible for new catalog selections. */
    const catalog = (accountId, seasonId, { search = '', page = 1, limit = 50 } = {}) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const where = {
                farmId: season.pond.farm.id,
                status: 'ACTIVE',
                ...(search && {
                    name: {
                        contains: search,
                        mode: 'insensitive',
                    },
                }),
            };
            const [totalResults, products] = await Promise.all([
                tx.product.count({ where }),
                tx.product.findMany({
                    where,
                    select: PRODUCT_SELECT,
                    orderBy: [{ name: 'asc' }, { id: 'asc' }],
                    skip: (page - 1) * limit,
                    take: limit,
                }),
            ]);
            return {
                data: products.map((product) => ({
                    ...product,
                    materialRevision: materialRevision(product),
                    conversionQuantity:
                        product.conversionQuantity == null
                            ? null
                            : String(product.conversionQuantity),
                })),
                meta: {
                    page,
                    limit,
                    totalResults,
                },
            };
        });

    /**
     * Group measurement units by dimension when checking whether a dose can use a selected product.
     */
    const unitFamily = (unit) =>
        ({
            KG: 'mass',
            G: 'mass',
            MG: 'mass',
            L: 'volume',
            ML: 'volume',
        })[unit] || unit;
    /**
     * Validate inclusive day ranges, existing identities, dose rules and product compatibility.
     * Retained inactive products may stay in a draft; submission revalidates them as new selections.
     */
    const validateGraph = async (
        tx,
        season,
        stages,
        current,
        accountId,
        assessProposals = true,
    ) => {
        if (treatment) {
            assertTreatmentStart(season.treatmentStartAt, season);
            assertTreatmentFirstStage(stages);
        }
        /** Map treatment days to the season's real DOC before checking dose and day-one timing rules. */
        const assertDose = (entry, window, product, environment, meal) => {
            const dueAtMinutes =
                entry.dueAtMinutes ?? PRODUCTION_PROTOCOL_LIMITS.defaultDueAtMinutes;
            if (
                !Number.isInteger(dueAtMinutes) ||
                dueAtMinutes < PRODUCTION_PROTOCOL_LIMITS.minDueAtMinutes ||
                dueAtMinutes > 2147483647
            )
                throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.DUE_WINDOW_INVALID);
            let first = window.first + 1;
            let last = window.last + 1;
            if (treatment && season.treatmentStartAt && season.stockingDate) {
                const start = new Date(season.treatmentStartAt);
                first = cultureDay(season.stockingDate, start) + window.first;
                last = first + window.last - window.first;
                if (
                    window.first === 0 &&
                    meal.plannedTime &&
                    plannedTime(meal.plannedTime).toISOString().slice(11, 23) <
                        new Date(start.getTime() + 7 * 3600000).toISOString().slice(11, 23)
                ) {
                    throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.FIRST_OCCURRENCE);
                }
            } else if (
                treatment &&
                ['PER_KG_BIOMASS', 'PERCENT_BIOMASS'].includes(entry.doseBasis)
            ) {
                throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.START_REQUIRED);
            }
            const firstDose = new Prisma.Decimal(entry.doseValue).plus(
                new Prisma.Decimal(entry.dailyDoseIncrement ?? 0).mul(
                    window.first - (entry.doseAnchorOffset ?? window.first),
                ),
            );
            assertTemplateDose(
                {
                    ...entry,
                    endDay: last,
                    doseValue: Number(firstDose),
                    dailyDoseIncrement: Number(entry.dailyDoseIncrement ?? 0),
                },
                product,
                first,
                environment,
            );
        };
        await assertStorageReady(tx);
        if (hasOverlappingStages(stages)) {
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.STAGE_OVERLAP);
        }
        if (stages.some((stage) => stage.meals.some(
            (meal) => meal.mealNumber != null && !structure.hasSharedMealDeadline(meal),
        ))) {
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.MEAL_DEADLINE_MISMATCH);
        }
        if (!treatment) assertProtocolHarvestCoverage(stages, season);
        const groups = current ? structure.protocolGroups(current) : [];
        const existingStages = new Set(groups.map((stage) => stage.id));
        const existingMeals = new Set(
            groups.flatMap((stage) => stage.meals.map((meal) => meal.id)),
        );
        const oldItems = new Map(current?.items.map((entry) => [entry.id, entry]));
        const allIds = new Set();
        /** Reject duplicate stage, meal or item IDs and identities outside this saved graph. */
        const checkId = (id, existing) => {
            if (id && (!existing.has(id) || allIds.has(id))) {
                throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.ID);
            }
            if (id) {
                allIds.add(id);
            }
        };
        const ids = [
            ...new Set(
                stages
                    .flatMap((stage) =>
                        stage.meals.flatMap((meal) => meal.items.map((entry) => entry.productId)),
                    )
                    .filter(Boolean),
            ),
        ];
        // Prevent an active product becoming inactive or moving farms while a draft is written.
        for (const id of [...ids].sort()) {
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${id}::uuid FOR SHARE`;
        }
        const products = await tx.product.findMany({
            where: { id: { in: ids } },
            select: PRODUCT_SELECT,
        });
        const byId = new Map(products.map((product) => [product.id, product]));
        for (const stage of stages) {
            checkId(stage.id, existingStages);
            for (const meal of stage.meals) {
                checkId(meal.id, existingMeals);
                for (const entry of meal.items) {
                    checkId(entry.id, oldItems);
                    const window = structure.itemWindow(entry, stage);
                    if (entry.productId) {
                        const previous = oldItems.get(entry.id);
                        // Accepted proposals keep their canonical, server-owned declaration and
                        // Owner overrides. The editor's DTO uppercases product enums and strips
                        // those stamps, so it must not replace the saved proposal on a graph edit.
                        const retained =
                            previous?.productId === entry.productId
                                ? previous.recommendedProductDetails
                                : null;
                        entry.recommendedProductDetails = retained
                            ? JSON.parse(JSON.stringify(retained))
                            : null;
                        // A different catalogue selection is a new reference. Its prior proposal
                        // remains in submission history, not attached to the replacement product.
                        entry.recommendedManufacturerId = retained
                            ? (previous.recommendedManufacturerId ?? null)
                            : null;
                    }
                    if (!entry.productId && !entry.recommendedProductDetails?.proposed)
                        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
                    if (!entry.productId && entry.recommendedProductDetails) {
                        if (assessProposals)
                            entry.recommendedProductDetails = structure.normalizeProposal(
                                entry.recommendedProductDetails,
                                accountId,
                            );
                        const proposal = productFromRecommendation(entry.recommendedProductDetails);
                        const proposedManufacturerId =
                            entry.recommendedProductDetails.proposed.manufacturerId;
                        if (
                            entry.recommendedManufacturerId &&
                            proposedManufacturerId &&
                            entry.recommendedManufacturerId !== proposedManufacturerId
                        ) {
                            throw ApiError.badRequest(
                                messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION,
                            );
                        }
                        entry.recommendedManufacturerId =
                            entry.recommendedManufacturerId ?? proposedManufacturerId ?? null;
                        assertMaterialSafety(
                            proposal,
                            meal.mealNumber == null,
                            entry.instructions,
                            { production: !treatment },
                        );
                        assertDose(entry, window, proposal, meal.mealNumber == null, meal);
                        if (entry.recommendedManufacturerId) {
                            const manufacturer = await tx.supplier.findFirst({
                                where: {
                                    id: entry.recommendedManufacturerId,
                                    ownerId: season.pond.farm.ownerId,
                                    status: 'active',
                                    supplierType: { in: ['MANUFACTURER', 'BOTH'] },
                                },
                                select: { id: true },
                            });
                            if (!manufacturer)
                                throw ApiError.badRequest(
                                    messages.PRODUCTION_PROTOCOL.MATERIAL_RESOLUTION,
                                );
                        }
                    }
                    if (!entry.productId) continue;
                    const product = byId.get(entry.productId);
                    const unchanged = oldItems.get(entry.id)?.productId === entry.productId;
                    if (
                        !product ||
                        product.farmId !== season.pond.farm.id ||
                        (!unchanged && product.status !== 'ACTIVE')
                    ) {
                        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
                    }
                    assertMaterialRevision(product, entry.productRevision);
                    const operationType =
                        product.category === 'FEED' ? 'FEEDING' : product.category;
                    if (entry.operationType !== operationType) {
                        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.PRODUCT);
                    }
                    assertMaterialSafety(
                        { ...product, productCompliance: product.compliance },
                        meal.mealNumber == null,
                        entry.instructions,
                        { production: !treatment },
                    );
                    assertDose(entry, window, product, meal.mealNumber == null, meal);
                    entry._materialSnapshot = JSON.parse(JSON.stringify(product));
                    const baseUnit =
                        Number(product.conversionQuantity) > 0 && product.conversionUnit
                            ? product.conversionUnit
                            : product.unit;
                    if (
                        entry.doseUnit !== product.unit &&
                        unitFamily(entry.doseUnit) !== unitFamily(baseUnit)
                    ) {
                        throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.UNIT);
                    }
                }
            }
        }
    };
    /**
     * Replace the validated graph while retaining item identities and unique sequence keys.
     * Writes use the caller's transaction and convert API offsets to one-based database DOC.
     */
    const persistGraph = async (tx, protocolId, stages, current) => {
        for (const stage of stages) {
            stage.id ??= randomUUID();
            for (const meal of stage.meals) meal.id ??= randomUUID();
        }
        await tx.protocol.update({
            where: { id: protocolId },
            data: {
                productionStructure: structure.storedStructure(stages),
            },
        });
        const oldItems = current?.items || [];
        const retained = new Set(
            stages
                .flatMap((stage) =>
                    stage.meals.flatMap((meal) => meal.items.map((entry) => entry.id)),
                )
                .filter(Boolean),
        );
        await tx.protocolItem.deleteMany({
            where: {
                protocolId,
                id: {
                    in: oldItems
                        .filter((entry) => !retained.has(entry.id))
                        .map((entry) => entry.id),
                },
            },
        });
        // Reserve order keys below the existing minimum, including imported negative keys.
        const floor = Math.min(0, ...oldItems.map((entry) => entry.sequenceOrder));
        const kept = oldItems.filter((entry) => retained.has(entry.id));
        if (floor - kept.length < -2147483648) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
        }
        for (const [index, entry] of kept.entries()) {
            await tx.protocolItem.update({
                where: { id: entry.id },
                data: { sequenceOrder: floor - index - 1 },
            });
        }
        let sequenceOrder = 0;
        for (const stage of stages) {
            for (const meal of stage.meals) {
                for (const entry of meal.items) {
                    const { id, dailyDoseIncrement, _materialSnapshot, ...fields } = entry;
                    delete fields.productRevision;
                    for (const field of [
                        'firstDayOffset',
                        'lastDayOffset',
                        'recurrenceAnchorOffset',
                        'doseAnchorOffset',
                    ])
                        delete fields[field];
                    const window = structure.itemWindow(entry, stage);
                    if (fields.recommendedProductDetails === null)
                        fields.recommendedProductDetails = Prisma.DbNull;
                    const data = {
                        ...fields,
                        dueAtMinutes:
                            fields.dueAtMinutes ?? PRODUCTION_PROTOCOL_LIMITS.defaultDueAtMinutes,
                        startDayOffset: window.first + 1,
                        endDayOffset: window.last + 1,
                        mealNumber: meal.mealNumber,
                        plannedTime: plannedTime(meal.plannedTime),
                        sequenceOrder: ++sequenceOrder,
                        updatedAt: new Date(),
                        productionMealId: meal.id,
                        dailyDoseIncrement: dailyDoseIncrement ?? '0',
                        recurrenceAnchorDay: window.recurrence + 1,
                        doseAnchorDay: window.doseAnchor + 1,
                        materialSnapshot: _materialSnapshot ?? Prisma.DbNull,
                    };
                    if (id) {
                        await tx.protocolItem.update({
                            where: { id },
                            data,
                        });
                    } else {
                        await tx.protocolItem.create({
                            data: {
                                protocolId,
                                ...data,
                            },
                        });
                    }
                }
            }
        }
    };
    /**
     * Limit new selections to active templates for the season's farm and compatible shrimp type.
     */
    const templateWhere = (season) => ({
        farmId: season.pond.farm.id,
        // Only active templates are eligible for new selections; existing snapshots remain independent.
        status: TemplateStatus.active,
        OR: [{ shrimpType: null }, { shrimpType: season.shrimpType }],
    });

    /** Scope the template and verify that its stored precision can be imported without loss. */
    const requireTemplate = async (tx, season, templateId) => {
        if (treatment)
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.PRODUCTION_TEMPLATE_FORBIDDEN);
        const template = await tx.productionProtocolTemplate.findFirst({
            where: {
                id: templateId,
                ...templateWhere(season),
            },
            include: {
                items: {
                    orderBy: { sequenceOrder: 'asc' },
                    include: { product: { select: PRODUCT_SELECT } },
                },
            },
        });
        if (!template) {
            throw ApiError.notFound(messages.PRODUCTION_PROTOCOL.TEMPLATE_NOT_FOUND);
        }
        await assertStorageReady(tx);
        // Prisma Date keeps milliseconds only; reject imported microsecond times instead of rounding them.
        const precise = await tx.$queryRaw`SELECT id FROM production_protocol_template_items
            WHERE template_id=${templateId}::uuid
            AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric,1000)<>0 LIMIT 1`;
        if (precise.length) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TIME_PRECISION);
        return template;
    };

    /** List eligible template headers without loading their item graphs. */
    const templates = (accountId, seasonId, { search = '', page = 1, limit = 50 } = {}) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const where = {
                ...templateWhere(season),
                ...(search && {
                    title: {
                        contains: search,
                        mode: 'insensitive',
                    },
                }),
            };
            const [totalResults, rows] = await Promise.all([
                tx.productionProtocolTemplate.count({ where }),
                tx.productionProtocolTemplate.findMany({
                    where,
                    orderBy: [{ title: 'asc' }, { id: 'asc' }],
                    skip: (page - 1) * limit,
                    take: limit,
                    select: {
                        id: true,
                        title: true,
                        shrimpType: true,
                        allowedVariancePct: true,
                        versionNo: true,
                    },
                }),
            ]);
            const precise = rows.length
                ? await tx.$queryRaw`
            SELECT DISTINCT template_id AS id FROM production_protocol_template_items
            WHERE template_id IN (${Prisma.join(rows.map((row) => Prisma.sql`${row.id}::uuid`))})
            AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric,1000)<>0`
                : [];
            const unsupported = new Set(precise.map((row) => row.id));
            return {
                data: rows.map((row) => ({
                    ...row,
                    canApply: !unsupported.has(row.id),
                    applicationMessage: unsupported.has(row.id)
                        ? messages.PRODUCTION_PROTOCOL.TIME_PRECISION
                        : null,
                    allowedVariancePct: String(row.allowedVariancePct),
                })),
                meta: {
                    page,
                    limit,
                    totalResults,
                    applicationMessage: null,
                },
            };
        });

    /** Return an editable copy; never mutate the template or scale prescriptions by post count. */
    const templateDetail = (accountId, seasonId, templateId) =>
        transaction(async (tx) => {
            const season = await scope(tx, accountId, seasonId);
            const template = await requireTemplate(tx, season, templateId);
            const items = template.items;
            return {
                title: template.title,
                summary: template.description,
                allowedVariancePct: String(template.allowedVariancePct),
                rollingWindowDays: 3,
                templateVersionNo: template.versionNo,
                referencePostCount: template.referencePostCount,
                stages: structure.templateGroups(items),
                editorItems: items.map((item) => {
                    const product = item.product
                        ? { ...item.product, productCompliance: item.product.compliance }
                        : productFromRecommendation(item.recommendedProductDetails);
                    if (!product) throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.PRODUCT);
                    return {
                        id: item.id,
                        startDay: item.startDayOfCulture,
                        endDay: item.endDayOfCulture,
                        plannedTime: item.plannedTime?.toISOString().slice(11, 23) ?? null,
                        mealNumber: item.mealNumber,
                        operationType: item.operationType,
                        repeatIntervalDays: item.repeatIntervalDays,
                        doseBasis: item.doseBasis,
                        doseValue: Number(item.doseValue),
                        doseUnit: item.doseUnit,
                        dailyDoseIncrement: Number(item.dailyDoseIncrement ?? 0),
                        dueAtMinutes: item.dueAtMinutes,
                        instructions: item.instructions,
                        product: {
                            ...product,
                            safety: getMaterialSafety(product),
                            ...(item.productId && { materialRevision: materialRevision(product) }),
                        },
                    };
                }),
            };
        });

    /**
     * Revalidate saved content before transitioning to PENDING_APPROVAL in the caller's transaction.
     * Clear previous review fields and save a submission snapshot with the Owner notification.
     * Treatment stays inactive until Owner approval and the Expert's prescribed start both permit it.
     */
    const submitCurrent = async (tx, season, accountId, current, notifications) => {
        if (treatment && current.sourceTemplateId)
            throw ApiError.badRequest(messages.TREATMENT_PROTOCOL.PRODUCTION_TEMPLATE_FORBIDDEN);
        const fromStatus = current.status;
        if (treatment) {
            if (
                !current.treatmentStartAt ||
                current.treatmentStartAt <= new Date() ||
                !season.stockingDate ||
                !['OPEN', 'MONITORING', 'IN_TREATMENT'].includes(season.diseaseCase.status) ||
                current.items.some((item) => item.dueAtMinutes == null)
            ) {
                throw ApiError.conflict(messages.TREATMENT_PROTOCOL.START_REQUIRED);
            }
            season.treatmentStartAt = current.treatmentStartAt;
        }
        if (!current.items.length || current.items.some((item) => item.plannedTime == null)) {
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
        }
        const groups = structure.protocolGroups(current).map((stage) => ({
            startDayOffset: stage.startDayOffset,
            endDayOffset: stage.endDayOffset,
            meals: stage.meals.map((meal) => ({
                mealNumber: meal.mealNumber,
                plannedTime: meal.plannedTime,
                items: meal.items.map(copyItem),
            })),
        }));
        if (
            groups.some(
                (stage) => !stage.meals.length || stage.meals.some((meal) => !meal.items.length),
            )
        ) {
            throw ApiError.badRequest(messages.PRODUCTION_PROTOCOL.SUBMIT_INCOMPLETE);
        }
        // Revalidate all products as newly selected: inactive products can remain in
        // draft history, but cannot be submitted as operational recommendations.
        await validateGraph(tx, season, groups, null, accountId, false);
        if (treatment) assertTreatmentCourse(current, season, { future: true });
        const result = await tx.protocol.updateMany({
            where: {
                id: current.id,
                status: fromStatus,
            },
            data: {
                status: 'PENDING_APPROVAL',
                submittedAt: new Date(),
                updatedAt: new Date(),
                reviewedAt: null,
                reviewedBy: null,
                rejectionReason: null,
            },
        });
        if (result.count !== 1) {
            throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
        }
        await appendHistory(
            tx,
            current.id,
            fromStatus.toLowerCase(),
            'pending_approval',
            accountId,
            null,
            'SUBMITTED',
            { snapshot: { ...current, stages: protocolStages(current) } },
        );
        const ownerId = season.pond.farm.ownerId;
        const notification = await tx.notification.create({
            data: {
                accountId: ownerId,
                type: treatment
                    ? NOTIFICATION_TYPE.TREATMENT_PROTOCOL_PENDING
                    : NOTIFICATION_TYPE.PRODUCTION_PROTOCOL_PENDING,
                title: messages.PRODUCTION_PROTOCOL.PENDING_NOTIFICATION_TITLE,
                content: messages.PRODUCTION_PROTOCOL.PENDING_NOTIFICATION_CONTENT(
                    current.title,
                    current.versionNo,
                    season.name,
                    season.pond.name,
                    season.pond.farm.name,
                ),
                referenceType: 'protocol',
                referenceId: current.id,
            },
            select: { id: true },
        });
        notifications.push({ accountId: ownerId, id: notification.id });
    };

    /** Require an editable status, matching revision and no dependencies before standalone submission. */
    const submit = (accountId, seasonId, protocolId, body) =>
        transaction(async (tx, notifications) => {
            const season = await scope(tx, accountId, seasonId, true);
            await tx.$queryRaw`SELECT id FROM protocols WHERE id = ${protocolId}::uuid FOR UPDATE`;
            const current = await findProtocol(tx, seasonId, protocolId);
            if (
                !PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(current.status) ||
                revisionOf(current) !== body.revision
            ) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
            }
            if (await blockers(tx, current)) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DEPENDENCY);
            }
            await submitCurrent(tx, season, accountId, current, notifications);
            return wireDetail(
                await findProtocol(tx, seasonId, protocolId),
                season,
                false,
                await history(tx, protocolId),
            );
        });

    /**
     * Create the next version only when no draft, rejected or pending version is in progress.
     * Link the latest version, including cancelled ones; optional submission remains atomic.
     * Creating a successor does not stop the currently effective treatment or change the case state.
     */
    const create = (accountId, seasonId, body) =>
        transaction(async (tx, notifications) => {
            if (treatment && (body.templateId || body.templateVersionNo != null))
                throw ApiError.badRequest(
                    messages.TREATMENT_PROTOCOL.PRODUCTION_TEMPLATE_FORBIDDEN,
                );
            const season = await scope(tx, accountId, seasonId, true);
            if (
                await tx.protocol.count({
                    where: {
                        seasonId,
                        protocolType,
                        diseaseCaseId,
                        status: { in: PRODUCTION_PROTOCOL_IN_PROGRESS_STATUSES },
                    },
                })
            ) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.IN_PROGRESS);
            }
            const latest = await tx.protocol.findFirst({
                where: {
                    seasonId,
                    protocolType,
                    diseaseCaseId,
                },
                orderBy: { versionNo: 'desc' },
            });
            if (treatment)
                season.treatmentStartAt = body.treatmentStartAt
                    ? new Date(body.treatmentStartAt)
                    : null;
            await validateGraph(tx, season, body.stages, null, accountId);
            const { stages, submitForApproval, templateId, templateVersionNo, ...header } = body;
            header.rollingWindowDays = 3;
            let template;
            if (templateId) {
                await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
                template = await requireTemplate(tx, season, templateId);
                if (template.versionNo !== templateVersionNo)
                    throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
            }
            const row = await tx.protocol.create({
                data: {
                    ...header,
                    ...(treatment && { rollingWindowDays: 3 }),
                    sourceTemplateId: templateId || null,
                    sourceTemplateSnapshot: template
                        ? { name: template.title, version: template.versionNo }
                        : Prisma.DbNull,
                    seasonId,
                    protocolType,
                    diseaseCaseId,
                    status: 'DRAFT',
                    versionNo: (latest?.versionNo || 0) + 1,
                    supersedesProtocolId: latest?.id || null,
                    createdBy: accountId,
                },
            });
            await persistGraph(tx, row.id, stages, null);
            await appendHistory(tx, row.id, null, 'draft', accountId);
            if (submitForApproval) {
                await submitCurrent(
                    tx,
                    season,
                    accountId,
                    await findProtocol(tx, seasonId, row.id),
                    notifications,
                );
            }
            return wireDetail(
                await findProtocol(tx, seasonId, row.id),
                season,
                false,
                await history(tx, row.id),
            );
        });
    /**
     * Edit only an unblocked DRAFT or REJECTED version whose revision still matches.
     * Omitted fields retain their values; changing the treatment anchor revalidates saved items too.
     */
    const mutate = (accountId, seasonId, protocolId, body) =>
        transaction(async (tx, notifications) => {
            const season = await scope(tx, accountId, seasonId, true);
            await tx.$queryRaw`SELECT id FROM protocols WHERE id = ${protocolId}::uuid FOR UPDATE`;
            const current = await findProtocol(tx, seasonId, protocolId);
            if (!PRODUCTION_PROTOCOL_EDITABLE_STATUSES.includes(current.status)) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.STATE);
            }
            if (revisionOf(current) !== body.revision) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
            }
            if (await blockers(tx, current)) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DEPENDENCY);
            }
            const { stages, submitForApproval, templateId, templateVersionNo, ...header } = body;
            delete header.revision;
            if (treatment && (templateId || templateVersionNo != null))
                throw ApiError.badRequest(
                    messages.TREATMENT_PROTOCOL.PRODUCTION_TEMPLATE_FORBIDDEN,
                );
            header.rollingWindowDays = 3;
            if (treatment) {
                header.sourceTemplateId = null;
                header.sourceTemplateSnapshot = Prisma.DbNull;
            }
            if (treatment)
                season.treatmentStartAt =
                    header.treatmentStartAt === undefined
                        ? current.treatmentStartAt
                        : header.treatmentStartAt
                          ? new Date(header.treatmentStartAt)
                          : null;
            let template;
            if (templateId !== undefined) {
                // Preserve snapshot references when the source template becomes inactive.
                if (
                    templateId &&
                    (templateId !== current.sourceTemplateId ||
                        (templateVersionNo != null &&
                            templateVersionNo !== current.sourceTemplateSnapshot?.version))
                ) {
                    await tx.$queryRaw`SELECT id FROM production_protocol_templates WHERE id = ${templateId}::uuid FOR SHARE`;
                    template = await requireTemplate(tx, season, templateId);
                    if (!stages)
                        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
                    if (template.versionNo !== templateVersionNo)
                        throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TEMPLATE_CHANGED);
                }
                header.sourceTemplateId = templateId;
            }
            if (stages) {
                // Prisma Date truncates TIME(6) to milliseconds. Do not rewrite imported
                // sub-millisecond times through the editor and silently lose precision.
                const precise = await tx.$queryRaw`SELECT id FROM protocol_items
                WHERE protocol_id = ${protocolId}::uuid
                AND MOD(EXTRACT(MICROSECONDS FROM planned_time)::numeric, 1000) <> 0 LIMIT 1`;
                if (precise.length) {
                    throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.TIME_PRECISION);
                }
                await validateGraph(tx, season, stages, current, accountId);
            }
            if (treatment && !stages && header.treatmentStartAt !== undefined)
                await validateGraph(tx, season, protocolStages(current), current, accountId, false);
            if (template)
                header.sourceTemplateSnapshot = {
                    name: template.title,
                    version: template.versionNo,
                };
            else if (templateId === null) header.sourceTemplateSnapshot = Prisma.DbNull;
            const result = await tx.protocol.updateMany({
                where: {
                    id: protocolId,
                    status: current.status,
                },
                data: {
                    ...header,
                    updatedAt: new Date(),
                },
            });
            if (result.count !== 1) {
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
            }
            if (stages) await persistGraph(tx, protocolId, stages, current);
            if (submitForApproval) {
                await submitCurrent(
                    tx,
                    season,
                    accountId,
                    await findProtocol(tx, seasonId, protocolId),
                    notifications,
                );
            }
            return wireDetail(
                await findProtocol(tx, seasonId, protocolId),
                season,
                false,
                await history(tx, protocolId),
            );
        });

    /** Delete only the last unpublished draft aggregate, never a submitted or operational fact. */
    const remove = (accountId, seasonId, protocolId, body) =>
        transaction(async (tx) => {
            await scope(tx, accountId, seasonId, true);
            await tx.$queryRaw`SELECT id FROM protocols WHERE id=${protocolId}::uuid FOR UPDATE`;
            const current = await findProtocol(tx, seasonId, protocolId);
            if (!isUnsubmittedDraft(current))
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DRAFT_DELETE_STATE);
            if (revisionOf(current) !== body.revision)
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
            if (!(await drafts.tryRemove(tx, current)))
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.DEPENDENCY);
            return { id: protocolId };
        });

    /**
     * Reconcile time-driven changes under the season lock before checking the confirmed revision.
     * The lifecycle service cancels an unapplied plan or aborts active treatment with care instructions.
     */
    const stop = async (accountId, seasonId, protocolId, body) => {
        const result = await transaction(async (tx, notifications) => {
            const season = await scope(tx, accountId, seasonId, true);
            if (!treatment) throw ApiError.conflict(messages.TREATMENT_PROTOCOL.STATE);
            notifications.push(...(await lifecycle.reconcile(tx, seasonId)));
            await tx.$queryRaw`SELECT id FROM protocols WHERE id=${protocolId}::uuid FOR UPDATE`;
            const current = await findProtocol(tx, seasonId, protocolId);
            if (body.revision && revisionOf(current) !== body.revision)
                throw ApiError.conflict(messages.PRODUCTION_PROTOCOL.CONFLICT);
            notifications.push(
                ...(await lifecycle.stop(tx, current, season.diseaseCase, accountId, body)),
            );
            return wireDetail(
                await findProtocol(tx, seasonId, protocolId),
                season,
                true,
                await history(tx, protocolId),
            );
        });
        require('../jobs').requestSeason(seasonId);
        return result;
    };

    return {
        stop,
        getSeason,
        list,
        detail,
        catalog,
        create,
        submit,
        templates,
        templateDetail,
        update: mutate,
        remove,
    };
};

module.exports = {
    production: createWorkflow(),
    forTreatment: (diseaseCaseId) => createWorkflow({ protocolType: 'TREATMENT', diseaseCaseId }),
};
