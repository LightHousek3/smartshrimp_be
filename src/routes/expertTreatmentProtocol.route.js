const router = require('express').Router({ mergeParams: true });
const { validate } = require('../middlewares');
const controller = require('../controllers/expertTreatmentProtocol.controller');
const validator = require('../validators/expertTreatmentProtocol.validator');

// Authentication and the Expert guard belong to the parent disease-case router.
router.get('/context', validate(validator.getContext), controller.getContext);
router.post('/', validate(validator.create), controller.create);
router.get('/:protocolId', validate(validator.detail), controller.detail);
router.patch('/:protocolId', validate(validator.update), controller.update);
router.post('/:protocolId/cancel', validate(validator.cancel), controller.cancel);
router.post('/:protocolId/submit', validate(validator.submit), controller.submit);
router.post('/:protocolId/abort', validate(validator.stop), controller.stop);

module.exports = router;
