const express = require('express');
const authRoute = require('./auth.route');
const profileRoute = require('./profile.route');

const router = express.Router();

const routes = [
    { path: '/auth', route: authRoute },
    { path: '/profile', route: profileRoute },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

module.exports = router;
