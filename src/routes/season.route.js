const express = require('express');
const { seasonController } = require('../controllers');
const { ACCOUNT_ROLE } = require('../constants');
const { authenticate, authorize, validate } = require('../middlewares');
const { seasonValidator } = require('../validators');

const router = express.Router();

router.use(authenticate, authorize(ACCOUNT_ROLE.FARM_OWNER));

router.get('/', validate(seasonValidator.getSeasons), seasonController.getSeasons);
router.post('/', validate(seasonValidator.createSeason), seasonController.createSeason);
router.get('/:seasonId', validate(seasonValidator.getSeason), seasonController.getSeason);
router.patch(
    '/:seasonId/activate',
    validate(seasonValidator.activateSeason),
    seasonController.activateSeason,
);
router.patch(
    '/:seasonId/cancel',
    validate(seasonValidator.cancelSeason),
    seasonController.cancelSeason,
);
router.patch('/:seasonId', validate(seasonValidator.updateSeason), seasonController.updateSeason);

module.exports = router;
