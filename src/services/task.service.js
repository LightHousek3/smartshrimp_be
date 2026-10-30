const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { httpStatus, messages, FARM_STATUS, TASK_OPEN_STATUSES, TASK_STATUSES, TASK_LIMITS } = require('../constants');
const { emitNotification } = require('../realtime/notification.socket');

const identity = { id: true, fullName: true, email: true };
const listSelect = {
    id: true, title: true, priority: true, status: true, dueAt: true,
    assignee: { select: identity }, completedAt: true, cancelledAt: true,
};
const detailSelect = {
    ...listSelect, description: true, farmId: true, seasonId: true,
    assignedTo: true, startedAt: true, completedAt: true,
    cancellationReason: true, createdAt: true, assigner: { select: identity },
    season: { select: { id: true, name: true, pond: { select: { id: true, name: true } } } },
    farm: { select: { id: true, name: true } },
};
const nameOf = (account) => account && ({ id: account.id, name: account.fullName || account.email });
const present = ({ assignee, assigner, season, ...row }) => ({
    ...row,
    ...(assignee !== undefined && { assignee: nameOf(assignee) }),
    ...(assigner !== undefined && { assigner: nameOf(assigner) }),
    ...(season !== undefined && { season: season ? { id: season.id, name: season.name } : null,
        pond: season?.pond ?? null }),
});
const scope = (ownerId) => ({ farm: { ownerId } });
const activeFarm = (ownerId) => ({ ownerId, status: FARM_STATUS.ACTIVE });
const technician = (ownerId) => ({ managedByOwnerId: ownerId, role: 'TECHNICIAN', status: 'ACTIVE' });

/**
 * List one owned status with tab totals from the same ownership scope and snapshot.
 */
const listTasks = async (ownerId, { status = 'PENDING', page = 1, limit = 20 } = {}) => {
    const now = new Date();
    const orderBy = status === 'COMPLETED' ? [{ completedAt: 'desc' }, { id: 'desc' }]
        : status === 'CANCELLED' ? [{ cancelledAt: 'desc' }, { id: 'desc' }]
            : [{ dueAt: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }];
    return prisma.$transaction(async (tx) => {
        const where = { ...scope(ownerId), status };
        const [rows, totals] = await Promise.all([
            tx.task.findMany({ where, select: listSelect, skip: (page - 1) * limit, take: limit, orderBy }),
            tx.task.groupBy({ by: ['status'], where: scope(ownerId), _count: { _all: true } }),
        ]);
        const counts = Object.fromEntries(TASK_STATUSES.map((value) => [value, 0]));
        for (const total of totals) counts[total.status] = total._count._all;
        const totalResults = counts[status];
        return { tasks: rows.map(present), meta: { page, limit, totalResults, counts,
            hasNextPage: page * limit < totalResults, serverNow: now } };
    }, { isolationLevel: 'RepeatableRead' });
};

/**
 * Return the shared assignment/timeline facts and identifiers required by owner editing.
 */
const getTask = async (ownerId, taskId, client = prisma) => {
    const task = await client.task.findFirst({ where: { id: taskId, ...scope(ownerId) }, select: detailSelect });
    if (!task) throw new ApiError(httpStatus.NOT_FOUND, messages.TASK.NOT_FOUND);
    return present(task);
};

/**
 * Supply compact dropdown choices; season choices always belong to the selected owned farm.
 */
const getOptions = async (ownerId, farmId) => {
    const selectedFarm = farmId ? await prisma.farm.findFirst({
        where: { id: farmId, ownerId }, select: { id: true },
    }) : null;
    if (farmId && !selectedFarm) {
        throw new ApiError(httpStatus.FORBIDDEN, messages.TASK.INVALID_FARM);
    }
    const [farms, accounts] = await Promise.all([
        prisma.farm.findMany({ where: activeFarm(ownerId), select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.account.findMany({ where: technician(ownerId), select: identity, orderBy: [{ fullName: 'asc' }, { id: 'asc' }] }),
    ]);
    // Season options use only active owned farms returned by the compact choices query.
    const seasons = farms.some((farm) => farm.id === farmId) ? await prisma.aquacultureSeason.findMany({
            where: { pond: { farmId, farm: activeFarm(ownerId) }, status: { in: ['PLANNING', 'ACTIVE'] } },
            select: { id: true, name: true, pond: { select: { name: true } }, personnelAssignments: {
                where: { role: 'TECHNICIAN', unassignedAt: null, account: technician(ownerId) },
                select: { account: { select: identity } },
            } }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }) : [];
    return { farms, technicians: accounts.map(nameOf), seasons: seasons.map(({ pond, personnelAssignments, ...s }) => ({
        ...s, pondName: pond.name,
        technician: personnelAssignments.length === 1 ? nameOf(personnelAssignments[0].account) : null,
    })) };
};

/**
 * Resolve the assignment on the server; client-supplied assignees cannot override a season's current KTV.
 */
const resolveAssignment = async (tx, ownerId, input) => {
    if (!await tx.farm.findFirst({ where: { id: input.farmId, ...activeFarm(ownerId) }, select: { id: true } })) {
        throw new ApiError(httpStatus.FORBIDDEN, messages.TASK.INVALID_FARM);
    }
    if (input.seasonId) {
        const season = await tx.aquacultureSeason.findFirst({
            where: { id: input.seasonId, status: { in: ['PLANNING', 'ACTIVE'] }, pond: { farmId: input.farmId } },
            select: { personnelAssignments: { where: { role: 'TECHNICIAN', unassignedAt: null,
                account: technician(ownerId) }, select: { accountId: true } } },
        });
        if (!season) throw new ApiError(httpStatus.BAD_REQUEST, messages.TASK.INVALID_SEASON);
        if (season.personnelAssignments.length !== 1) throw new ApiError(httpStatus.CONFLICT, messages.TASK.NO_TECHNICIAN);
        return season.personnelAssignments[0].accountId;
    }
    if (!input.assignedTo || !await tx.account.findFirst({
        where: { id: input.assignedTo, ...technician(ownerId) }, select: { id: true },
    })) throw new ApiError(httpStatus.BAD_REQUEST, messages.TASK.INVALID_ASSIGNEE);
    return input.assignedTo;
};

/**
 * Persist notification with the mutation; realtime delivery starts only after a successful commit.
 */
const mutate = async (operation) => {
    try {
        const { task, notification } = await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
        if (notification) emitNotification(notification.accountId, 'notification:new', { id: notification.id });
        return task;
    } catch (error) {
        if (error.code === 'P2004' && JSON.stringify(error.meta || {}).includes('tasks_due_at_future')) {
            throw new ApiError(httpStatus.BAD_REQUEST, messages.TASK.INVALID_DEADLINE);
        }
        if (error.code === 'P2034') throw new ApiError(httpStatus.CONFLICT, messages.TASK.CONFLICT);
        throw error;
    }
};
const notify = (tx, task, type, content) => tx.notification.create({ data: {
    accountId: task.assignedTo, title: task.title, type, content, referenceType: 'task', referenceId: task.id,
}, select: { id: true, accountId: true } });

/**
 * Validate changed deadlines immediately before writing; old overdue tasks remain editable.
 */
const requireFutureDeadline = (dueAt) => {
    if (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime()) ||
        dueAt.getTime() <= Date.now() + TASK_LIMITS.DEADLINE_LEAD_MS) {
        throw new ApiError(httpStatus.BAD_REQUEST, messages.TASK.INVALID_DEADLINE);
    }
};

/**
 * Create a pending task and the assignee notification as one atomic operation.
 */
const createTask = (ownerId, input) => mutate(async (tx) => {
    const assignedTo = await resolveAssignment(tx, ownerId, input);
    requireFutureDeadline(input.dueAt);
    const row = await tx.task.create({ data: { ...input, assignedTo, assignedBy: ownerId,
        description: input.description || null, seasonId: input.seasonId || null,
    } });
    const notification = await notify(tx, row, 'TASK_ASSIGNED', messages.TASK.ASSIGNED_NOTIFICATION);
    return { task: await getTask(ownerId, row.id, tx), notification };
});

const comparable = (value) => value instanceof Date ? value.toISOString() : value ?? null;

/**
 * Recheck ownership/state and calculate actual changes for the assignee notification only.
 */
const changeTask = (ownerId, taskId, input, cancelling = false) => mutate(async (tx) => {
    const current = await tx.task.findFirst({ where: { id: taskId, ...scope(ownerId) } });
    if (!current) throw new ApiError(httpStatus.NOT_FOUND, messages.TASK.NOT_FOUND);
    if (!TASK_OPEN_STATUSES.includes(current.status)) throw new ApiError(httpStatus.FORBIDDEN, messages.TASK.TERMINAL);
    if (!cancelling && current.status === 'IN_PROGRESS' && Object.keys(input).some((key) => !['description', 'priority', 'dueAt'].includes(key))) {
        throw new ApiError(httpStatus.FORBIDDEN, messages.TASK.LOCKED_FIELDS);
    }
    const now = new Date();
    const data = cancelling ? { status: 'CANCELLED', cancellationReason: input.reason, cancelledAt: now } : { ...input };
    if (!cancelling) {
        if ('dueAt' in data) requireFutureDeadline(data.dueAt);
        if ('description' in data) data.description = data.description || null;
        if (current.status === 'PENDING') data.assignedTo = await resolveAssignment(tx, ownerId, { ...current, ...data });
    }
    const changes = Object.fromEntries(Object.entries(data)
        .filter(([key, value]) => comparable(value) !== comparable(current[key]))
        .map(([key, value]) => [key, { before: comparable(current[key]), after: comparable(value) }]));
    if (!Object.keys(changes).length) return { task: await getTask(ownerId, taskId, tx) };
    // The predicate also rejects progress/reassignment changes racing with this request.
    const result = await tx.task.updateMany({ where: { id: taskId, status: current.status,
        assignedTo: current.assignedTo, ...scope(ownerId) },
    data: { ...data, updatedAt: now } });
    if (result.count !== 1) throw new ApiError(httpStatus.CONFLICT, messages.TASK.CONFLICT);
    const updated = { ...current, ...data };
    const content = cancelling ? messages.TASK.CANCELLED_NOTIFICATION(input.reason) :
        messages.TASK.UPDATED_NOTIFICATION(Object.entries(changes).map(([key, value]) =>
            `${messages.TASK.FIELD_LABELS[key] || key}: ${value.before ?? '—'} → ${value.after ?? '—'}`).join('; '));
    const notification = await notify(tx, updated, 'TASK_UPDATED', content);
    return { task: await getTask(ownerId, taskId, tx), notification };
});

/**
 * Edit an owned task using the state-specific field policy in changeTask.
 */
const updateTask = (ownerId, taskId, input) => changeTask(ownerId, taskId, input);

/**
 * Record server cancellation time together with the reason and assignee notification.
 */
const cancelTask = (ownerId, taskId, input) => changeTask(ownerId, taskId, input, true);

const assignedListSelect = {
    id: true, title: true, priority: true, status: true, dueAt: true,
    completedAt: true, cancelledAt: true,
};

/**
 * Keep completed/cancelled assignments visible even after a season's KTV changes.
 * Tab counts and rows use one snapshot; deadlines without a value sort last.
 */
const listAssignedTasks = async (accountId, { group = 'TODO', page = 1, limit = 20 } = {}) =>
    prisma.$transaction(async (tx) => {
        const statuses = group === 'TODO' ? TASK_OPEN_STATUSES : ['COMPLETED', 'CANCELLED'];
        const [tasks, totals] = await Promise.all([
            tx.task.findMany({ where: { assignedTo: accountId, status: { in: statuses } },
                select: assignedListSelect, skip: (page - 1) * limit, take: limit,
                orderBy: group === 'TODO'
                    ? [{ priority: 'desc' }, { dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
                    : [{ updatedAt: 'desc' }, { id: 'desc' }],
            }),
            tx.task.groupBy({ by: ['status'], where: { assignedTo: accountId }, _count: { _all: true } }),
        ]);
        const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
        for (const total of totals) counts[total.status] = total._count._all;
        const totalResults = statuses.reduce((sum, status) => sum + counts[status], 0);
        return { tasks, meta: { page, limit, counts, totalResults,
            hasNextPage: page * limit < totalResults, serverNow: new Date() } };
    }, { isolationLevel: 'RepeatableRead' });

/**
 * Read shared assignment facts. Task access does not grant
 * season access: only a current season assignment enables the related pond link.
 */
const getAssignedTask = async (accountId, taskId, client = prisma) => {
    const row = await client.task.findFirst({ where: { id: taskId, assignedTo: accountId },
        select: { ...assignedListSelect, description: true, startedAt: true, createdAt: true,
            cancellationReason: true, assigner: { select: identity }, assignee: { select: identity },
            farm: { select: { id: true, name: true } },
            season: { select: { id: true, name: true, pond: { select: { id: true, name: true } },
                personnelAssignments: { where: { accountId, role: 'TECHNICIAN', unassignedAt: null },
                    select: { id: true }, take: 1 } } },
        } });
    if (!row) throw new ApiError(httpStatus.NOT_FOUND, messages.TASK.NOT_FOUND);
    return { ...present(row),
        canOpenRelatedSeason: Boolean(row.season?.personnelAssignments.length),
    };
};

/**
 * Advance exactly one step using server time. Serializable isolation and the
 * state/assignee predicate reject racing starts, edits and cancellations.
 * Completion notification commits together with the transition.
 */
const updateAssignedTaskStatus = (accountId, taskId, { status }) => mutate(async (tx) => {
    const current = await tx.task.findFirst({ where: { id: taskId, assignedTo: accountId },
        select: { id: true, title: true, status: true, startedAt: true,
            farm: { select: { ownerId: true } } } });
    if (!current) throw new ApiError(httpStatus.NOT_FOUND, messages.TASK.NOT_FOUND);
    const expected = { IN_PROGRESS: 'PENDING', COMPLETED: 'IN_PROGRESS' }[status];
    if (!expected || current.status !== expected || (status === 'COMPLETED' && !current.startedAt)) {
        throw new ApiError(httpStatus.CONFLICT, messages.TASK.INVALID_TRANSITION);
    }
    const now = new Date();
    const timestamp = status === 'IN_PROGRESS' ? 'startedAt' : 'completedAt';
    const result = await tx.task.updateMany({ where: { id: taskId, assignedTo: accountId,
        status: expected }, data: { status, [timestamp]: now } });
    if (result.count !== 1) throw new ApiError(httpStatus.CONFLICT, messages.TASK.CONFLICT);
    const notification = status === 'COMPLETED' ? await tx.notification.create({ data: {
        accountId: current.farm.ownerId, title: current.title, type: 'TASK_COMPLETED',
        content: messages.TASK.COMPLETED_NOTIFICATION, referenceType: 'task', referenceId: taskId,
    }, select: { id: true, accountId: true } }) : undefined;
    return { task: await getAssignedTask(accountId, taskId, tx), notification };
});

module.exports = { listTasks, getTask, getOptions, createTask, updateTask, cancelTask,
    listAssignedTasks, getAssignedTask, updateAssignedTaskStatus };
