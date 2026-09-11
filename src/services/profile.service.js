const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_STATUS, USER_ROLE } = require('../constants');

const PROFILE_ROLES = [USER_ROLE.TECHNICIAN, USER_ROLE.FARM_OWNER, USER_ROLE.EXPERT];
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

const eligibleProfileWhere = (userId) => ({
    id: userId,
    status: ACCOUNT_STATUS.ACTIVE,
    role: { in: PROFILE_ROLES },
});

const normalizeTechnicianKpi = (role, kpi) => {
    if (role !== USER_ROLE.TECHNICIAN) return null;

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
        profile.role === USER_ROLE.TECHNICIAN
            ? await database.technicianKpi.findFirst({
                where: { technicianId: profile.id },
            })
            : null;

    return {
        ...profile,
        technicianKpi: normalizeTechnicianKpi(profile.role, kpi),
    };
};

const getProfile = async (userId) => {
    const profile = await prisma.user.findFirst({
        where: eligibleProfileWhere(userId),
        select: PUBLIC_PROFILE_SELECT,
    });

    if (!profile) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.PROFILE.NOT_FOUND);
    }

    return withProfileDetails(prisma, profile);
};

const updateProfile = async (userId, profileData) =>
    prisma.$transaction(async (transaction) => {
        const updateResult = await transaction.user.updateMany({
            where: eligibleProfileWhere(userId),
            data: profileData,
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        const profile = await transaction.user.findUnique({
            where: { id: userId },
            select: PUBLIC_PROFILE_SELECT,
        });

        if (!profile) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        return withProfileDetails(transaction, profile);
    });

const changePassword = async (userId, currentPassword, newPassword) => {
    const user = await prisma.user.findFirst({
        where: eligibleProfileWhere(userId),
        select: { id: true, passwordHash: true },
    });

    if (!user?.passwordHash) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.PROFILE.NOT_FOUND);
    }

    const currentPasswordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentPasswordMatches) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.PROFILE.CURRENT_PASSWORD_INCORRECT);
    }

    const reusesCurrentPassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (reusesCurrentPassword) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.PROFILE.PASSWORD_REUSE_NOT_ALLOWED);
    }

    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    const changedAt = new Date();

    await prisma.$transaction(async (transaction) => {
        const updateResult = await transaction.user.updateMany({
            where: {
                ...eligibleProfileWhere(userId),
                passwordHash: user.passwordHash,
            },
            data: { passwordHash },
        });

        if (updateResult.count !== 1) {
            throw new ApiError(httpStatus.CONFLICT, messages.PROFILE.UPDATE_CONFLICT);
        }

        await transaction.refreshToken.updateMany({
            where: { userId, revokedAt: null },
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
