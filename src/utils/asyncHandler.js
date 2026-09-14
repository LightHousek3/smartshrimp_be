/**
 * Wraps an async route handler to catch errors and forward to Express error middleware.
 * Eliminates the need for try-catch blocks in every controller.
 *
 * @param {Function} fn - Async route handler function
 * @returns {Function} Express middleware function
 *
 * @example
 * router.get('/accounts', asyncHandler(async (req, res) => {
 *   const accounts = await accountService.list();
 *   res.json(accounts);
 * }));
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
