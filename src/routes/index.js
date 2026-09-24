const express = require('express');
const authRoute = require('./auth.route');
const adminAccountRoute = require('./adminAccount.route');
const profileRoute = require('./profile.route');
const farmRoute = require('./farm.route');
const notificationRoute = require('./notification.route');
<<<<<<< Updated upstream
const pondRoute = require('./pond.route');
=======
const personnelRoute = require('./personnel.route');
>>>>>>> Stashed changes

const router = express.Router();

const routes = [
    { path: '/auth', route: authRoute },
    { path: '/admin/accounts', route: adminAccountRoute },
    { path: '/profile', route: profileRoute },
<<<<<<< Updated upstream
    { path: '/owner/farms', route: farmRoute },
    { path: '/owner/farms/:farmId/ponds', route: pondRoute },
=======
    { path: '/owner/personnel', route: personnelRoute },
>>>>>>> Stashed changes
    { path: '/notifications', route: notificationRoute },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

module.exports = router;
