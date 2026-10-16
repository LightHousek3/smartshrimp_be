const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { ACCOUNT_ROLE, httpStatus, messages } = require('../constants');

const seasonSelect = { id: true, pondId: true, pond: { select: { farmId: true } } };
const seasonContext = (season) => (season ? {
    seasonId: season.id, pondId: season.pondId, farmId: season.pond.farmId,
} : {});
const seasonScope = (accountId, role) => (role === ACCOUNT_ROLE.FARM_OWNER
    ? { pond: { farm: { ownerId: accountId } } }
    : { personnelAssignments: { some: {
        accountId,
        role: role === ACCOUNT_ROLE.EXPERT ? 'EXPERT' : 'TECHNICIAN',
        ...(role === ACCOUNT_ROLE.EXPERT ? {} : { unassignedAt: null }),
    } }, ...(role === ACCOUNT_ROLE.EXPERT ? { OR: [
        { status: { in: ['COMPLETED', 'CANCELLED'] } },
        { personnelAssignments: { some: { accountId, role: 'EXPERT', unassignedAt: null } } },
    ] } : {}) });

// Return identifiers only after verifying both notification ownership and current
// resource access. The client maps these identifiers to its supported screens.
const getNotificationReferenceContext = async (accountId, notificationId, role) => {
    const notification = await prisma.notification.findFirst({
        where: { id: notificationId, accountId },
        select: { referenceType: true, referenceId: true },
    });
    if (!notification) throw new ApiError(httpStatus.NOT_FOUND, messages.NOTIFICATION.NOT_FOUND);
    const id = notification.referenceId?.trim();
    if (!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) return {};
    if (![ACCOUNT_ROLE.FARM_OWNER, ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.EXPERT].includes(role)) return {};
    const type = notification.referenceType?.trim().toLowerCase();
    const scope = seasonScope(accountId, role);
    switch (type) {
    case 'product': {
        if (role !== ACCOUNT_ROLE.FARM_OWNER) return {};
        const product = await prisma.product.findFirst({
            where: { id, isDeleted: false, farm: { ownerId: accountId, isDeleted: false } },
            select: { id: true, farmId: true },
        });
        return product ? { productId: product.id, farmId: product.farmId } : {};
    }
    case 'pond': {
        if (role !== ACCOUNT_ROLE.FARM_OWNER) {
            return seasonContext(await prisma.aquacultureSeason.findFirst({
                where: { pondId: id, ...scope }, select: seasonSelect,
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            }));
        }
        const pond = await prisma.pond.findFirst({
            where: { id, farm: { ownerId: accountId } }, select: { id: true, farmId: true },
        });
        return pond ? { pondId: pond.id, farmId: pond.farmId } : {};
    }
    case 'season':
    case 'aquaculture_season':
        return seasonContext(await prisma.aquacultureSeason.findFirst({
            where: { id, ...scope }, select: seasonSelect,
        }));
    case 'water_log':
    case 'water_quality_log': {
        const log = await prisma.waterQualityLog.findFirst({
            where: { id, season: scope }, select: { season: { select: seasonSelect } },
        });
        return seasonContext(log?.season);
    }
    case 'operation_schedule': {
        const schedule = await prisma.operationSchedule.findFirst({
            where: { id, season: scope }, select: { id: true, season: { select: seasonSelect } },
        });
        return schedule ? { ...seasonContext(schedule.season), scheduleId: schedule.id } : {};
    }
    case 'operation_execution': {
        const execution = await prisma.operationExecution.findFirst({
            where: { id, schedule: { season: scope } },
            select: { schedule: { select: { id: true, season: { select: seasonSelect } } } },
        });
        // Some older records use the schedule ID as their execution reference.
        const schedule = execution?.schedule ?? await prisma.operationSchedule.findFirst({
            where: { id, season: scope }, select: { id: true, season: { select: seasonSelect } },
        });
        return schedule ? { ...seasonContext(schedule.season), scheduleId: schedule.id } : {};
    }
    case 'protocol':
    case 'production_protocol':
    case 'treatment_protocol': {
        const protocol = await prisma.protocol.findFirst({
            where: { id, season: scope }, select: { season: { select: seasonSelect } },
        });
        return seasonContext(protocol?.season);
    }
    case 'disease_case': {
        const disease = await prisma.diseaseCase.findFirst({
            where: { id, season: scope }, select: { season: { select: seasonSelect } },
        });
        return seasonContext(disease?.season);
    }
    default:
        return {};
    }
};

module.exports = { getNotificationReferenceContext };
