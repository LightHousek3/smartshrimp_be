const express = require('express');
const authRoute = require('./auth.route');
const adminAccountRoute = require('./adminAccount.route');
const profileRoute = require('./profile.route');
const farmRoute = require('./farm.route');
const notificationRoute = require('./notification.route');
const pondRoute = require('./pond.route');
const personnelRoute = require('./personnel.route');
const seasonRoute = require('./season.route');
const assignedSeasonRoute = require('./assignedSeason.route');
const expertDashboardRoute = require('./expertDashboard.route');
const expertSeasonRoute = require('./expertSeason.route');
const ragRoute = require('./rag.route');

const router = express.Router();

const routes = [
    { path: '/me/rag', route: ragRoute },
    { path: '/auth', route: authRoute },
    { path: '/admin/accounts', route: adminAccountRoute },
    { path: '/profile', route: profileRoute },
    { path: '/owner/farms', route: farmRoute },
    { path: '/owner/farms/:farmId/ponds', route: pondRoute },
    { path: '/owner/personnel', route: personnelRoute },
    { path: '/owner/seasons', route: seasonRoute },
    { path: '/me/seasons', route: assignedSeasonRoute },
    { path: '/expert/dashboard', route: expertDashboardRoute },
    { path: '/expert/seasons', route: expertSeasonRoute },
    { path: '/notifications', route: notificationRoute },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

module.exports = router;
