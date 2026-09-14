const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS, ACCOUNT_ROLE } = require('../constants');

const PROFILE_ROLES = [
    ACCOUNT_ROLE.TECHNICIAN,
    ACCOUNT_ROLE.FARM_OWNER,
    ACCOUNT_ROLE.EXPERT,
];
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

const eligibleProfileWhere = (accountId) => ({
    id: accountId,
    status: ACCOUNT_STATUS.ACTIVE,
    role: { in: PROFILE_ROLES },
});

const normalizeTechnicianKpi = (role, kpi) => {
    if (role !== ACCOUNT_ROLE.TECHNICIAN) return null;

    return {
        seasonsParticipated: Number(kpi?.seasonsParticipated ?? 0),
        completedTasks: Number(kpi?.completedTasks ?? 0),
        onTimeCompletedTasks: Number(kpi?.onTimeCompletedTasks ?? 0),
        onTimeCompletionRatePct:
            kpi?.onTimeCompletionRatePct == null
                ? null
                : Number(kpi.onTimeCompletionRatePct),
    };
};

const withProfileDetails = async (database, profile) => {
    const kpi =
        profile.role === ACCOUNT_ROLE.TECHNICIAN
            ? await database.technicianKpi.findFirst({
                where: { technicianId: profile.id },
            })
            : null;

    return {
        ...profile,
        technicianKpi: normalizeTechnicianKpi(profile.role, kpi),
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

const changePassword = async (accountId, currentPassword, newPassword) => {
    const account = await prisma.account.findFirst({
        where: eligibleProfileWhere(accountId),
        select: { id: true, passwordHash: true },
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

    await prisma.$transaction(async (transaction) => {
        const updateResult = await transaction.account.updateMany({
            where: {
                ...eligibleProfileWhere(accountId),
                passwordHash: account.passwordHash,
            },
            data: { passwordHash },
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        await transaction.refreshToken.updateMany({
            where: { accountId, revokedAt: null },
            data: { revokedAt: changedAt },
        });
    });
};

module.exports = {
    getProfile,
    updateProfile,
    changePassword,
    PUBLIC_PROFILE_SELECT,
    PUBLIC_MANAGER_SELECT,
    normalizeTechnicianKpi,
};
