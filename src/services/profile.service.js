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

/**
 * Recheck active status and supported profile roles at the database boundary.
 */
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

const EMPTY_PROFILE_KPIS = Object.freeze({
    technicianKpi: null,
    expertKpi: null,
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
});

/**
 * Attach normalized read-only KPIs for staff using the caller’s database client.
 * Profile updates must read their result inside the same transaction.
 */
const withProfileDetails = async (database, profile) => {
    const config = KPI_CONFIG_BY_ROLE[profile.role];
    // Only staff have KPI projections. Owners receive identity and personnel context.
    if (!config) return { ...profile, ...EMPTY_PROFILE_KPIS };

    const kpi = await database[config.delegate].findUnique({
        where: { [config.idField]: profile.id },
    });

    return {
        ...profile,
        ...EMPTY_PROFILE_KPIS,
        [config.responseField]: config.normalize(kpi),
    };
};

/**
 * Read an active Technician, Expert or Owner profile without selecting credentials.
 * Missing or no-longer-eligible accounts produce the same not-found response.
 */
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

/**
 * Update editable identity fields only while the account remains eligible.
 * The count predicate detects a concurrent status change; result and staff KPI reads share the transaction.
 */
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

/**
 * Verify the current password and reject password reuse before generating a new hash.
 * Password replacement, revocation of all refresh tokens and current-device token issuance
 * must commit together; the password hash is removed from the returned account.
 */
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
};
