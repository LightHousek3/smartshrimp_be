const router = require('express').Router();
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { taskValidator } = require('../validators');
const { taskController } = require('../controllers');

// ─── Task Management ──────────────────────────────────────────────────────────

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

/**
 * @route   GET /api/v1/owner/tasks
 * @desc    Get task list
 * @access  Private (Farm Owner)
 */
router.get('/', validate(taskValidator.list), taskController.list);

/**
 * @route   GET /api/v1/owner/tasks/form-options
 * @desc    Get task form options
 * @access  Private (Farm Owner)
 */
router.get('/form-options', validate(taskValidator.options), taskController.options);

/**
 * @route   GET /api/v1/owner/tasks/:taskId
 * @desc    Get task details
 * @access  Private (Farm Owner)
 */
router.get('/:taskId', validate(taskValidator.detail), taskController.detail);

/**
 * @route   POST /api/v1/owner/tasks
 * @desc    Create a task
 * @access  Private (Farm Owner)
 */
router.post('/', validate(taskValidator.create), taskController.create);

/**
 * @route   PATCH /api/v1/owner/tasks/:taskId
 * @desc    Update a task
 * @access  Private (Farm Owner)
 */
router.patch('/:taskId', validate(taskValidator.update), taskController.update);

/**
 * @route   PATCH /api/v1/owner/tasks/:taskId/cancel
 * @desc    Cancel a task
 * @access  Private (Farm Owner)
 */
router.patch('/:taskId/cancel', validate(taskValidator.cancel), taskController.cancel);

module.exports = router;
