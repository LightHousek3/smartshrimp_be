const router = require('express').Router();
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { taskValidator } = require('../validators');
const { taskController } = require('../controllers');

router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));

/**
 * @route   GET /api/v1/technician/tasks
 * @desc    List assigned tasks by open/ended group
 * @access  Private (Technician)
 */
router.get('/', validate(taskValidator.assignedList), taskController.assignedList);

/**
 * @route   GET /api/v1/technician/tasks/:taskId
 * @desc    Read one assigned task and its execution timeline
 * @access  Private (Technician)
 */
router.get('/:taskId', validate(taskValidator.detail), taskController.assignedDetail);

/**
 * @route   PATCH /api/v1/technician/tasks/:taskId/status
 * @desc    Start or complete an assigned task
 * @access  Private (Technician)
 */
router.patch('/:taskId/status', validate(taskValidator.progress), taskController.progress);

module.exports = router;
