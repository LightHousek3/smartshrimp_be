const router = require('express').Router({ mergeParams: true });
const { authenticate, authorize, validate } = require('../middlewares');
const { ACCOUNT_ROLE } = require('../constants');
const { diseaseCaseController: controller } = require('../controllers');
const { diseaseCaseValidator: validator } = require('../validators');

// /api/v1/me/seasons/:seasonId/disease-cases — current assigned technicians only.
router.use(authenticate, authorize(ACCOUNT_ROLE.TECHNICIAN));
router.get('/', validate(validator.list), controller.list);
router.post('/', validate(validator.create), controller.create);
router.get('/:caseId', validate(validator.detail), controller.detail);
router.post('/:caseId/responses', validate(validator.respond), controller.respond);
module.exports = router;
