const express = require('express');
const { pondController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { pondValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router({ mergeParams: true });
router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

router.get('/', validate(pondValidator.getPonds), pondController.getPonds);
router.post('/', validate(pondValidator.createPond), pondController.createPond);
router.get('/:pondId', validate(pondValidator.getPond), pondController.getPond);
router.patch('/:pondId/archive', validate(pondValidator.changeArchiveStatus), pondController.archivePond);
router.patch('/:pondId/restore', validate(pondValidator.changeArchiveStatus), pondController.restorePond);
router.patch('/:pondId', validate(pondValidator.updatePond), pondController.updatePond);

module.exports = router;
