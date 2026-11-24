const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, ACCOUNT_ROLE, ACCOUNT_STATUS } = require('../constants');
const emailService = require('./email.service');
const tokenService = require('./token.service');

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
    phone: true,
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

/**
 * Build the shared account filter so the page and total count use the same criteria.
 */
const buildAccountFilter = ({ role, status, managedByOwnerId, search, createdFrom, createdTo }) => {
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

/**
 * Keep unnamed accounts last when sorting by identity and break ties by ID for cursor pagination.
 */
const buildAccountOrderBy = (sortBy, sortOrder) => {
    const direction = sortOrder === 'desc' ? 'desc' : 'asc';

    if (sortBy === 'identity') {
        return [
            { fullName: { sort: direction, nulls: 'last' } },
            { email: direction },
            { id: direction },
        ];
    }

    if (sortBy === 'createdAt') {
        return [{ createdAt: direction }, { id: direction }];
    }

    return [{ createdAt: 'desc' }, { id: 'desc' }];
};

/**
 * Resolve managing owners in one batch and expose an owner summary in place of the foreign key.
 */
const attachManagingOwners = async (accounts) => {
    const ownerIds = [
        ...new Set(accounts.map((account) => account.managedByOwnerId).filter(Boolean)),
    ];

    if (ownerIds.length === 0) {
        return accounts.map(({ managedByOwnerId, ...account }) => ({
            ...account,
            managedByOwner: null,
        }));
    }

    const owners = await prisma.account.findMany({
        where: { id: { in: ownerIds } },
        select: OWNER_LIST_SELECT,
    });
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

    return accounts.map(({ managedByOwnerId, ...account }) => ({
        ...account,
        managedByOwner: ownersById.get(managedByOwnerId) || null,
    }));
};

/**
 * Return a cursor page of admin account summaries with managing owner context and a filtered total.
 */
const getListAccount = async ({
    cursor,
    limit,
    role,
    status,
    managedByOwnerId,
    search,
    createdFrom,
    createdTo,
    sortBy,
    sortOrder,
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
        prisma.account.findMany({
            where,
            select: ACCOUNT_LIST_SELECT,
            orderBy: buildAccountOrderBy(sortBy, sortOrder),
            take: limit + 1,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        }),
        prisma.account.count({ where }),
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

/**
 * Return the admin account detail with its managing owner and managed staff count.
 */
const getAccountById = async (accountId) => {
    const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: ACCOUNT_SELECT,
    });

    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
    }

    const [managedByOwner, managedStaffCount] = await Promise.all([
        account.managedByOwnerId
            ? prisma.account.findUnique({
                  where: { id: account.managedByOwnerId },
                  select: OWNER_SUMMARY_SELECT,
              })
            : Promise.resolve(null),
        prisma.account.count({ where: { managedByOwnerId: account.id } }),
    ]);

    return { ...account, managedByOwner, managedStaffCount };
};

/**
 * Staff accounts require an active farm owner. Use the caller's database client during account writes.
 */
const validateManagingOwner = async (database, role, managedByOwnerId) => {
    const isStaff = role === ACCOUNT_ROLE.TECHNICIAN || role === ACCOUNT_ROLE.EXPERT;

    if (!isStaff) {
        return;
    }

    const owner = await database.account.findUnique({
        where: { id: managedByOwnerId },
        select: { id: true, role: true, status: true },
    });

    if (!owner || owner.role !== ACCOUNT_ROLE.FARM_OWNER) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.ACCOUNT.INVALID_MANAGING_OWNER);
    }

    if (owner.status !== ACCOUNT_STATUS.ACTIVE) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.OWNER_NOT_ACTIVE);
    }
};

/** Send an invitation only; verification codes are requested by the recipient. */
const sendActivationEmail = async (account) => {
    const current = await findPendingActivationAccount(account.id);
    try {
        await emailService.sendAccountActivationEmail({ email: current.email, role: current.role });
    } catch (_) {
        throw new ApiError(
            httpStatus.SERVICE_UNAVAILABLE,
            messages.ACCOUNT.ACTIVATION_EMAIL_FAILED,
        );
    }
    return { email: current.email };
};

/** Report committed account changes even when invitation delivery fails. */
const inviteSavedAccount = async (account) => {
    try {
        const activation = await sendActivationEmail(account);
        return { ...account, activation, activationEmailSent: true };
    } catch (error) {
        // The account transaction has already committed. Report that fact so an
        // administrator can resend the invitation instead of retrying creation.
        if (
            error instanceof ApiError &&
            error.statusCode === httpStatus.SERVICE_UNAVAILABLE &&
            error.message === messages.ACCOUNT.ACTIVATION_EMAIL_FAILED
        ) {
            return { ...account, activation: null, activationEmailSent: false };
        }
        throw error;
    }
};

/**
 * Create a pending account under a valid managing owner and send the activation invitation after
 * commit.
 */
const createAccount = async ({ email, role, managedByOwnerId }, adminId) => {
    let account;

    try {
        account = await prisma.$transaction(async (transaction) => {
            await validateManagingOwner(transaction, role, managedByOwnerId);

            return transaction.account.create({
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

    return inviteSavedAccount(account);
};

/**
 * Distinguish an unknown account from one that can no longer receive a pending activation invitation.
 */
const findPendingActivationAccount = async (accountId) => {
    const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, email: true, role: true, status: true },
    });

    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
    }

    if (account.status !== ACCOUNT_STATUS.PENDING_ACTIVATION) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.ACTIVATION_NOT_PENDING);
    }

    return account;
};

/**
 * Reissue an activation invitation link for an account still awaiting activation.
 * Invitation delivery does not invalidate an OTP already requested by the recipient.
 */
const resendActivation = async (accountId) =>
    sendActivationEmail(await findPendingActivationAccount(accountId));

/**
 * Correct the contact email address of an account in PENDING_ACTIVATION status.
 * Reissues an updated invitation link and preserves unactivated challenge integrity.
 */
const updatePendingAccount = async (accountId, { email }) => {
    const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { id: true, email: true, status: true },
    });

    if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
    }

    if (account.status !== ACCOUNT_STATUS.PENDING_ACTIVATION) {
        throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.ONLY_PENDING_UPDATABLE);
    }

    const normalizedEmail = email.trim().toLowerCase();

    let updatedAccount;
    try {
        updatedAccount = await prisma.$transaction(async (transaction) => {
            const changed = await transaction.account.updateMany({
                where: {
                    id: accountId,
                    email: account.email,
                    status: ACCOUNT_STATUS.PENDING_ACTIVATION,
                },
                data: { email: normalizedEmail },
            });
            if (changed.count !== 1) {
                throw ApiError.conflict(messages.ACCOUNT.ONLY_PENDING_UPDATABLE);
            }
            if (normalizedEmail !== account.email) {
                await transaction.emailVerificationChallenge.updateMany({
                    where: { accountId, consumedAt: null, supersededAt: null },
                    data: { supersededAt: new Date() },
                });
            }
            return transaction.account.findUnique({
                where: { id: accountId },
                select: ACCOUNT_SELECT,
            });
        });
    } catch (error) {
        if (error.code === 'P2002') {
            throw new ApiError(httpStatus.CONFLICT, messages.ACCOUNT.EMAIL_ALREADY_EXISTS);
        }
        throw error;
    }

    return inviteSavedAccount(updatedAccount);
};

/**
 * Count planning and active seasons across the owner's ponds for the deactivation check.
 */
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

/**
 * Count open seasons where the staff member still holds an assignment.
 */
const countOpenStaffAssignments = async (database, accountId) => {
    const assignments = await database.seasonPersonnelAssignment.findMany({
        where: { accountId, unassignedAt: null },
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

/**
 * Require active staff and open operational responsibilities to be cleared before deactivation.
 */
const validateDeactivationEligibility = async (database, account) => {
    if (account.role === ACCOUNT_ROLE.FARM_OWNER) {
        const [activeStaffCount, openSeasonCount] = await Promise.all([
            database.account.count({
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

/**
 * Transition an account status with mandatory audit logging and assignment deactivation validation.
 * Deactivating an account revokes active refresh tokens and prevents access to managed farm resources.
 */
const updateAccountStatus = async (accountId, { status, reason }, adminId) =>
    prisma.$transaction(async (transaction) => {
        const account = await transaction.account.findUnique({
            where: { id: accountId },
            select: { id: true, role: true, status: true },
        });

        if (!account) {
            throw new ApiError(httpStatus.NOT_FOUND, messages.ACCOUNT.NOT_FOUND);
        }
        if (account.role === ACCOUNT_ROLE.ADMIN) {
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
        const updatedAccount = await transaction.account.update({
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
            await tokenService.revokeAllAccountTokens(account.id, transaction);
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
    updatePendingAccount,
    updateAccountStatus,
};
