const express = require('express');
const authRoute = require('./auth.route');

const router = express.Router();

const routes = [{ path: '/auth', route: authRoute }];

routes.forEach((route) => {
    router.use(route.path, route.route);
});

module.exports = router;
