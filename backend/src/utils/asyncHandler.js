// Wraps an async Express handler so a rejected promise is forwarded to the
// error-handling middleware instead of becoming an unhandled rejection — which,
// on Node 22, terminates the process. Express 5 does this natively; this shim
// covers our Express 4 handlers.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
