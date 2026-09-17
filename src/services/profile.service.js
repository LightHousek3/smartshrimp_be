const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS, ACCOUNT_ROLE } = require('../constants');
const tokenService = require('./token.service');

const PROFILE_ROLES = [ACCOUNT_ROLE.TECHNICIAN, ACCOUNT_ROLE.FARM_OWNER, ACCOUNT_ROLE.EXPERT];
const PASSWORD_HASH_ROUNDS = 12;

const PUBLIC_MANAGER_SELECT = {
    id: true,
    email: true,
    fullName: true,
    avatarUrl: true,
};

const PUBLIC_PROFILE_SELECT = {
    id: true,
    email: true,
    phone: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    activatedAt: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
    managedByOwner: {
        select: PUBLIC_MANAGER_SELECT,
    },
};

const CHANGE_PASSWORD_SELECT = {
    id: true,
    email: true,
    phone: true,
    passwordHash: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    activatedAt: true,
    lastLoginAt: true,
    createdAt: true,
    updatedAt: true,
};

const eligibleProfileWhere = (accountId) => ({
    id: accountId,
    status: ACCOUNT_STATUS.ACTIVE,
    role: { in: PROFILE_ROLES },
});

const numberOrZero = (value) => Number(value ?? 0);
const nullableNumber = (value) => (value == null ? null : Number(value));

const normalizeTechnicianKpi = (kpi) => ({
    seasonsParticipated: numberOrZero(kpi?.seasonsParticipated),
    completedTasks: numberOrZero(kpi?.completedTasks),
    onTimeCompletedTasks: numberOrZero(kpi?.onTimeCompletedTasks),
    onTimeCompletionRatePct: nullableNumber(kpi?.onTimeCompletionRatePct),
});

const normalizeExpertKpi = (kpi) => ({
    seasonsParticipated: numberOrZero(kpi?.seasonsParticipated),
    diseaseCasesHandled: numberOrZero(kpi?.diseaseCasesHandled),
    diseaseCasesResolved: numberOrZero(kpi?.diseaseCasesResolved),
    avgResolutionHours: nullableNumber(kpi?.avgResolutionHours),
});

const normalizeFarmOwnerKpi = (kpi) => ({
    farmsOwned: numberOrZero(kpi?.farmsOwned),
    pondsManaged: numberOrZero(kpi?.pondsManaged),
    activeSeasons: numberOrZero(kpi?.activeSeasons),
});

const EMPTY_PROFILE_KPIS = Object.freeze({
    technicianKpi: null,
    expertKpi: null,
    farmOwnerKpi: null,
});

const KPI_CONFIG_BY_ROLE = Object.freeze({
    [ACCOUNT_ROLE.TECHNICIAN]: {
        delegate: 'technicianKpi',
        idField: 'technicianId',
        responseField: 'technicianKpi',
        normalize: normalizeTechnicianKpi,
    },
    [ACCOUNT_ROLE.EXPERT]: {
        delegate: 'expertKpi',
        idField: 'expertId',
        responseField: 'expertKpi',
        normalize: normalizeExpertKpi,
    },
    [ACCOUNT_ROLE.FARM_OWNER]: {
        delegate: 'farmOwnerKpi',
        idField: 'farmOwnerId',
        responseField: 'farmOwnerKpi',
        normalize: normalizeFarmOwnerKpi,
    },
});

const withProfileDetails = async (database, profile) => {
    const config = KPI_CONFIG_BY_ROLE[profile.role];
    const kpi = await database[config.delegate].findUnique({
        where: { [config.idField]: profile.id },
    });

    return {
        ...profile,
        ...EMPTY_PROFILE_KPIS,
        [config.responseField]: config.normalize(kpi),
    };
};

const getProfile = async (accountId) => {
    const profile = await prisma.account.findFirst({
        where: eligibleProfileWhere(accountId),
        select: PUBLIC_PROFILE_SELECT,
    });

    if (!profile) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.PROFILE.NOT_FOUND);
    }

    return withProfileDetails(prisma, profile);
};

const updateProfile = async (accountId, profileData) =>
    prisma.$transaction(async (transaction) => {
        const updateResult = await transaction.account.updateMany({
            where: eligibleProfileWhere(accountId),
            data: profileData,
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        const profile = await transaction.account.findUnique({
            where: { id: accountId },
            select: PUBLIC_PROFILE_SELECT,
        });

        if (!profile) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        return withProfileDetails(transaction, profile);
    });

const changePassword = async (accountId, currentPassword, newPassword, deviceId) => {
    const account = await prisma.account.findFirst({
        where: eligibleProfileWhere(accountId),
        select: CHANGE_PASSWORD_SELECT,
    });

    if (!account?.passwordHash) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.PROFILE.NOT_FOUND);
    }

    const currentPasswordMatches = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!currentPasswordMatches) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.PROFILE.CURRENT_PASSWORD_INCORRECT);
    }

    const reusesCurrentPassword = await bcrypt.compare(newPassword, account.passwordHash);
    if (reusesCurrentPassword) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.PROFILE.PASSWORD_REUSE_NOT_ALLOWED);
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    const changedAt = new Date();
    const publicAccount = { ...account };
    delete publicAccount.passwordHash;

    const tokens = await prisma.$transaction(async (transaction) => {
        await transaction.account.update({
            where: {
                id: accountId,
            },
            data: { passwordHash },
        });

        await transaction.refreshToken.updateMany({
            where: { accountId, revokedAt: null },
            data: { revokedAt: changedAt },
        });

        return tokenService.generateAuthTokens(publicAccount, deviceId, transaction);
    });

    return { account: publicAccount, tokens };
};

module.exports = {
    getProfile,
    updateProfile,
    changePassword,
    PUBLIC_PROFILE_SELECT,
    PUBLIC_MANAGER_SELECT,
    normalizeTechnicianKpi,
    normalizeExpertKpi,
    normalizeFarmOwnerKpi,
};
