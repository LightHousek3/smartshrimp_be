const { authenticate, authorize, optionalAuth, loadActiveAccount } = require("./auth.middleware");
const {
  errorConverter,
  errorHandler,
  notFoundHandler,
} = require("./error.middleware");
const validate = require("./validate.middleware");
const { apiLimiter, authLimiter, writeLimiter } = require("./rateLimiter.middleware");

module.exports = {
  authenticate,
  authorize,
  optionalAuth,
  loadActiveAccount,
  errorConverter,
  errorHandler,
  notFoundHandler,
  validate,
  apiLimiter,
  authLimiter,
  writeLimiter,
};
