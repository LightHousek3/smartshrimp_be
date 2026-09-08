const { authenticate, authorize, optionalAuth } = require("./auth.middleware");
const {
  errorConverter,
  errorHandler,
  notFoundHandler,
} = require("./error.middleware");
const validate = require("./validate.middleware");
const { apiLimiter, authLimiter } = require("./rateLimiter.middleware");

module.exports = {
  authenticate,
  authorize,
  optionalAuth,
  errorConverter,
  errorHandler,
  notFoundHandler,
  validate,
  apiLimiter,
  authLimiter,
};
