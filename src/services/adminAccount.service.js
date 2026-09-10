const crypto = require('crypto');
const prisma = require('../config/prisma');
const config = require('../config');
const { ApiError } = require('../utils');
const { httpStatus, messages, USER_ROLE, ACCOUNT_STATUS } = require('../constants');
const emailService = require('./email.service');
const tokenService = require('./token.service');

const ACTIVATION_PURPOSE = 'ACCOUNT_ACTIVATION';
const ACTIVATION_RESEND_COOLDOWN_SECONDS = 60;
const OPEN_SEASON_STATUSES = ['PLANNING', 'ACTIVE'];

const ACCOUNT_SELECT = {
    id: true,
    email: true,
    phone: true,
    fullName: true,
    avatarUrl: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    activatedAt: true,
    statusChangedBy: true,
    statusChangedAt: true,
    statusReason: true,
    lastLoginAt: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
};

const ACCOUNT_LIST_SELECT = {
    id: true,
    email: true,
    fullName: true,
    role: true,
    status: true,
    managedByOwnerId: true,
    createdAt: true,
    lastLoginAt: true,
};

const OWNER_SUMMARY_SELECT = {
    id: true,
    email: true,
    fullName: true,
    status: true,
};

const OWNER_LIST_SELECT = {
    id: true,
    fullName: true,
};

const buildAccountFilter = ({
    role,
    status,
    managedByOwnerId,
    search,
    createdFrom,
    createdTo,
}) => {
    const where = {
        ...(role && { role }),
        ...(status && { status }),
        ...(managedByOwnerId && { managedByOwnerId }),
        ...((createdFrom || createdTo) && {
            createdAt: {
                ...(createdFrom && { gte: createdFrom }),
                ...(createdTo && { lte: createdTo }),
            },
        }),
    };

    if (search) {
        where.OR = [
            { email: { contains: search, mode: 'insensitive' } },
            { fullName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
        ];
    }

    return where;
};

const attachManagingOwners = async (accounts) => {
    const ownerIds = [...new Set(accounts.map((account) => account.managedByOwnerId).filter(Boolean))];

    if (ownerIds.length === 0) {
        return accounts.map(({ managedByOwnerId, ...account }) => ({
            ...account,
            managedByOwner: null,
        }));
    }

    const owners = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: OWNER_LIST_SELECT,
    });
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

    return accounts.map(({ managedByOwnerId, ...account }) => ({
        ...account,
        managedByOwner: ownersById.get(managedByOwnerId) || null,
    }));
};

const getListAccount = async ({
    cursor,
    limit,
    role,
    status,
    managedByOwnerId,
    search,
    createdFrom,
    createdTo,
}) => {
    const where = buildAccountFilter({
        role,
        status,
        managedByOwnerId,
        search,
        createdFrom,
        createdTo,
    });
    const [rows, totalResults] = await Promise.all([
        prisma.user.findMany({
            where,
            select: ACCOUNT_LIST_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        }),
        prisma.user.count({ where }),
    ]);

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const accounts = await attachManagingOwners(pageRows);

    return {
        accounts,
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null,
        },
    };
};

const getAccountById = async (accountId) => {
    const account = await prisma.user.findUnique({
        where: { id: accountId },
        select: ACCOUNT_SELECT,
    });

    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
    }

    const [managedByOwner, managedStaffCount] = await Promise.all([
        account.managedByOwnerId
            ? prisma.user.findUnique({
                where: { id: account.managedByOwnerId },
                select: OWNER_SUMMARY_SELECT,
            })
            : Promise.resolve(null),
        prisma.user.count({ where: { managedByOwnerId: account.id } }),
    ]);

    return { ...account, managedByOwner, managedStaffCount };
};

const validateManagingOwner = async (database, role, managedByOwnerId) => {
    const isStaff = role === USER_ROLE.TECHNICIAN || role === USER_ROLE.EXPERT;

    if (!isStaff) {
        return;
    }

    const owner = await database.user.findUnique({
        where: { id: managedByOwnerId },
        select: { id: true, role: true, status: true },
    });

    if (!owner || owner.role !== USER_ROLE.FARM_OWNER) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.ACCOUNT.INVALID_MANAGING_OWNER);
    }

    if (owner.status !== ACCOUNT_STATUS.ACTIVE) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.OWNER_NOT_ACTIVE);
    }
};

const createAccount = async ({ email, role, managedByOwnerId }, adminId) => {
    try {
        return await prisma.$transaction(async (transaction) => {
            await validateManagingOwner(transaction, role, managedByOwnerId);

            return transaction.user.create({
                data: {
                    email,
                    role,
                    status: ACCOUNT_STATUS.PENDING_ACTIVATION,
                    managedByOwnerId: managedByOwnerId || null,
                    createdBy: adminId,
                },
                select: ACCOUNT_SELECT,
            });
        });
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }

        if (error.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.EMAIL_ALREADY_EXISTS);
        }

        if (error.code === 'P2003') {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.ACCOUNT.INVALID_MANAGING_OWNER);
        }

        throw error;
    }
};

const hashActivationCode = (code) =>
    crypto.createHmac('sha256', config.jwt.accessSecret).update(code).digest('hex');

const resendActivation = async (accountId) => {
    const account = await prisma.user.findUnique({
        where: { id: accountId },
        select: { id: true, email: true, status: true },
    });

    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
    }

    if (account.status !== ACCOUNT_STATUS.PENDING_ACTIVATION) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.ACTIVATION_NOT_PENDING);
    }

    const now = new Date();
    const activeChallenge = await prisma.emailVerificationChallenge.findFirst({
        where: {
            userId: account.id,
            purpose: ACTIVATION_PURPOSE,
            consumedAt: null,
            supersededAt: null,
        },
        orderBy: { createdAt: 'desc' },
    });

    if (activeChallenge?.resendAvailableAt > now) {
        throw new ApiError(
            httpStatus.TOO_MANY_REQUESTS,
            messages.ACCOUNT.ACTIVATION_RESEND_TOO_SOON,
        );
    }

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const expiresAt = new Date(now.getTime() + config.email.verificationExpiresMinutes * 60000);
    const resendAvailableAt = new Date(
        now.getTime() + ACTIVATION_RESEND_COOLDOWN_SECONDS * 1000,
    );

    let challenge;

    try {
        challenge = await prisma.$transaction(async (transaction) => {
            await transaction.emailVerificationChallenge.updateMany({
                where: {
                    userId: account.id,
                    purpose: ACTIVATION_PURPOSE,
                    consumedAt: null,
                    supersededAt: null,
                },
                data: { supersededAt: now },
            });

            return transaction.emailVerificationChallenge.create({
                data: {
                    userId: account.id,
                    purpose: ACTIVATION_PURPOSE,
                    codeHash: hashActivationCode(code),
                    expiresAt,
                    resendAvailableAt,
                },
                select: { id: true, expiresAt: true, resendAvailableAt: true },
            });
        });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new ApiError(
                httpStatus.TOO_MANY_REQUESTS,
                messages.ACCOUNT.ACTIVATION_RESEND_TOO_SOON,
            );
        }
        throw error;
    }

    try {
        await emailService.sendAccountActivationEmail({
            email: account.email,
            code,
            expiresInMinutes: config.email.verificationExpiresMinutes,
        });
    } catch (error) {
        await prisma.emailVerificationChallenge.updateMany({
            where: { id: challenge.id, consumedAt: null, supersededAt: null },
            data: { supersededAt: new Date() },
        });
        throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.ACCOUNT.ACTIVATION_EMAIL_FAILED);
    }

    return {
        email: account.email,
        expiresAt: challenge.expiresAt,
        resendAvailableAt: challenge.resendAvailableAt,
    };
};

const countOpenOwnerSeasons = async (database, ownerId) => {
    const farms = await database.farm.findMany({
        where: { ownerId },
        select: { id: true },
    });
    if (farms.length === 0) return 0;

    const ponds = await database.pond.findMany({
        where: { farmId: { in: farms.map((farm) => farm.id) } },
        select: { id: true },
    });
    if (ponds.length === 0) return 0;

    return database.aquacultureSeason.count({
        where: {
            pondId: { in: ponds.map((pond) => pond.id) },
            status: { in: OPEN_SEASON_STATUSES },
        },
    });
};

const countOpenStaffAssignments = async (database, accountId) => {
    const assignments = await database.seasonPersonnelAssignment.findMany({
        where: { userId: accountId, unassignedAt: null },
        select: { seasonId: true },
    });
    if (assignments.length === 0) return 0;

    return database.aquacultureSeason.count({
        where: {
            id: { in: assignments.map((assignment) => assignment.seasonId) },
            status: { in: OPEN_SEASON_STATUSES },
        },
    });
};

const validateDeactivationEligibility = async (database, account) => {
    if (account.role === USER_ROLE.FARM_OWNER) {
        const [activeStaffCount, openSeasonCount] = await Promise.all([
            database.user.count({
                where: {
                    managedByOwnerId: account.id,
                    status: ACCOUNT_STATUS.ACTIVE,
                },
            }),
            countOpenOwnerSeasons(database, account.id),
        ]);

        if (activeStaffCount > 0) {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.OWNER_HAS_ACTIVE_STAFF);
        }
        if (openSeasonCount > 0) {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.OWNER_HAS_OPEN_SEASON);
        }
        return;
    }

    const openAssignmentCount = await countOpenStaffAssignments(database, account.id);
    if (openAssignmentCount > 0) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.STAFF_HAS_ACTIVE_ASSIGNMENT);
    }
};

const updateAccountStatus = async (accountId, { status, reason }, adminId) =>
    prisma.$transaction(async (transaction) => {
        const account = await transaction.user.findUnique({
            where: { id: accountId },
            select: { id: true, role: true, status: true },
        });

        if (!account) {
            throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
        }
        if (account.role === USER_ROLE.ADMIN) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.ACCOUNT.ADMIN_STATUS_PROTECTED);
        }
        if (account.status === ACCOUNT_STATUS.PENDING_ACTIVATION) {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.STATUS_PENDING_PROTECTED);
        }
        if (account.status === status) {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.STATUS_UNCHANGED);
        }

        if (account.status === ACCOUNT_STATUS.ACTIVE && status !== ACCOUNT_STATUS.ACTIVE) {
            await validateDeactivationEligibility(transaction, account);
        }

        const changedAt = new Date();
        const updatedAccount = await transaction.user.update({
            where: { id: account.id },
            data: {
                status,
                statusReason: reason,
                statusChangedBy: adminId,
                statusChangedAt: changedAt,
            },
            select: ACCOUNT_SELECT,
        });

        if (status !== ACCOUNT_STATUS.ACTIVE) {
            await tokenService.revokeAllUserTokens(account.id, transaction);
        }

        return updatedAccount;
    });

module.exports = {
    ACCOUNT_SELECT,
    ACCOUNT_LIST_SELECT,
    getListAccount,
    getAccountById,
    createAccount,
    resendActivation,
    updateAccountStatus,
};
