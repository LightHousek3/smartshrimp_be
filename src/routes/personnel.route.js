const express = require('express');
const { personnelController } = require('../controllers');
const { authenticate, authorize, validate } = require('../middlewares');
const { personnelValidator } = require('../validators');
const { ACCOUNT_ROLE } = require('../constants');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

router.get('/', validate(personnelValidator.getListPersonnel), personnelController.getListPersonnel);
router.get('/:personnelId', validate(personnelValidator.getPersonnel), personnelController.getPersonnel);

module.exports = router;
