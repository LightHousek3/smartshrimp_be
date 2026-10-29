const { taskService } = require('../services');
const { asyncHandler, ResponseHandler } = require('../utils');
const { messages } = require('../constants');

/**
 * GET /tasks
 */
const list = asyncHandler(async (req, res) => {
    const { tasks, meta } = await taskService.listTasks(req.account.id, req.query);
    ResponseHandler.paginated(res, {
        data: tasks,
        meta,
        message: messages.TASK.LIST_FETCHED,
    });
});

/**
 * GET /tasks/form-options
 */
const options = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await taskService.getOptions(req.account.id, req.query.farmId),
    });
});

/**
 * GET /tasks/:taskId
 */
const detail = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await taskService.getTask(req.account.id, req.params.taskId),
    });
});

/**
 * POST /tasks
 */
const create = asyncHandler(async (req, res) => {
    ResponseHandler.created(res, {
        data: await taskService.createTask(req.account.id, req.body),
        message: messages.TASK.CREATED,
    });
});

/**
 * PATCH /tasks/:taskId
 */
const update = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await taskService.updateTask(req.account.id, req.params.taskId, req.body),
        message: messages.TASK.UPDATED,
    });
});

/**
 * PATCH /tasks/:taskId/cancel
 */
const cancel = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await taskService.cancelTask(req.account.id, req.params.taskId, req.body),
        message: messages.TASK.CANCELLED,
    });
});

/** GET /me/tasks: list only the authenticated technician's assignments. */
const assignedList = asyncHandler(async (req, res) => {
    const { tasks, meta } = await taskService.listAssignedTasks(req.account.id, req.query);
    ResponseHandler.paginated(res, { data: tasks, meta, message: messages.TASK.LIST_FETCHED });
});

/** GET /me/tasks/:taskId: return assignment and execution facts. */
const assignedDetail = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, { data: await taskService.getAssignedTask(req.account.id, req.params.taskId) });
});

/** PATCH /me/tasks/:taskId/status: server records the execution timestamp. */
const progress = asyncHandler(async (req, res) => {
    ResponseHandler.success(res, {
        data: await taskService.updateAssignedTaskStatus(req.account.id, req.params.taskId, req.body),
        message: req.body.status === 'IN_PROGRESS' ? messages.TASK.STARTED : messages.TASK.COMPLETED,
    });
});

module.exports = { list, options, detail, create, update, cancel, assignedList, assignedDetail, progress };
