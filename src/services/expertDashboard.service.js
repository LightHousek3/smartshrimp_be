const prisma = require('../config/prisma');
const { PERSONNEL_ROLE, SEASON_STATUS } = require('../constants');

const localDate = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const visibleSeason = {
    pond: { isDeleted: false, farm: { isDeleted: false } },
};

const activeAssignment = (accountId, status) => ({
    accountId,
    role: PERSONNEL_ROLE.EXPERT,
    unassignedAt: null,
    season: { ...visibleSeason, status },
});

const toNumber = (value) => (value == null ? null : Number(value));

const getDayOfCulture = (stockingDate, now) => {
    if (!stockingDate) return null;
    const parts = Object.fromEntries(
        localDate
            .formatToParts(now)
            .filter(({ type }) => ['year', 'month', 'day'].includes(type))
            .map(({ type, value }) => [type, Number(value)]),
    );
    const today = Date.UTC(parts.year, parts.month - 1, parts.day);
    return Math.max(0, Math.floor((today - stockingDate.getTime()) / 86400000) + 1);
};

const normalizeSeason = ({ season }, now) => {
    const log = season.healthLogs[0];
    const population = toNumber(log?.estimatedPopulation);
    const initialQuantity = toNumber(season.initialQuantity);

    return {
        id: season.id,
        name: season.name,
        dayOfCulture: getDayOfCulture(season.stockingDate, now),
        pond: { name: season.pond.name },
        farm: { name: season.pond.farm.name },
        survivalRatePct:
            population != null && initialQuantity > 0
                ? Math.round((population / initialQuantity) * 1000) / 10
                : null,
        avgWeightG: toNumber(log?.avgWeightG),
        biomassKg: toNumber(log?.estimatedBiomassKg),
        healthStatus: log?.healthStatus ?? null,
    };
};

const normalizeCase = (item) => ({
    id: item.id,
    title: item.title,
    severity: item.severity,
    status: item.status,
    updatedAt: item.updatedAt,
    reporterName: item.reporter.fullName,
    season: { name: item.season.name },
    pond: { name: item.season.pond.name },
    farm: { name: item.season.pond.farm.name },
});

const getExpertDashboard = async (accountId, now = new Date()) => {
    const [
        assignments,
        planningSeasons,
        openCases,
        criticalCases,
        pendingProtocols,
        draftProtocols,
        rejectedProtocols,
        recentCases,
    ] = await Promise.all([
        prisma.seasonPersonnelAssignment.findMany({
            where: activeAssignment(accountId, SEASON_STATUS.ACTIVE),
            select: {
                season: {
                    select: {
                        id: true,
                        name: true,
                        stockingDate: true,
                        initialQuantity: true,
                        pond: { select: { name: true, farm: { select: { name: true } } } },
                        healthLogs: {
                            where: { isVoided: false },
                            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
                            take: 1,
                            select: {
                                estimatedPopulation: true,
                                avgWeightG: true,
                                estimatedBiomassKg: true,
                                healthStatus: true,
                            },
                        },
                    },
                },
            },
            orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        }),
        prisma.seasonPersonnelAssignment.count({
            where: activeAssignment(accountId, SEASON_STATUS.PLANNING),
        }),
        prisma.diseaseCase.count({ where: { expertId: accountId, status: { not: 'RESOLVED' } } }),
        prisma.diseaseCase.count({
            where: {
                expertId: accountId,
                status: { not: 'RESOLVED' },
                severity: 'CRITICAL',
            },
        }),
        prisma.protocol.count({ where: { createdBy: accountId, status: 'PENDING_APPROVAL' } }),
        prisma.protocol.count({ where: { createdBy: accountId, status: 'DRAFT' } }),
        prisma.protocol.count({ where: { createdBy: accountId, status: 'REJECTED' } }),
        prisma.diseaseCase.findMany({
            where: { expertId: accountId },
            select: {
                id: true,
                title: true,
                severity: true,
                status: true,
                updatedAt: true,
                reporter: { select: { fullName: true } },
                season: {
                    select: {
                        name: true,
                        pond: { select: { name: true, farm: { select: { name: true } } } },
                    },
                },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: 5,
        }),
    ]);

    return {
        summary: {
            activeSeasons: assignments.length + planningSeasons,
            planningSeasons,
            openCases,
            criticalCases,
            pendingProtocols,
            draftProtocols,
            rejectedProtocols,
        },
        seasons: assignments.map((assignment) => normalizeSeason(assignment, now)),
        recentCases: recentCases.map(normalizeCase),
    };
};

module.exports = { getExpertDashboard };
