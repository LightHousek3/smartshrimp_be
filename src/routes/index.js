const express = require('express');
const authRoute = require('./auth.route');
const adminAccountRoute = require('./adminAccount.route');

const router = express.Router();

const routes = [
    { path: '/auth', route: authRoute },
    { path: '/admin/accounts', route: adminAccountRoute },
];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

module.exports = router;
