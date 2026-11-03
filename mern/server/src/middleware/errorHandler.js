/**
 * Central Express error-handling middleware.
 * Equivalent to Spring's @ControllerAdvice.
 */
export function errorHandler(err, req, res, next) {
  console.error('Unhandled server error:', err);

  const status = err.statusCode || (err.name === 'ValidationError' ? 400 : 500);
  res.status(status).json({
    error: err.name || 'InternalServerError',
    message: err.message || 'An unexpected error occurred',
  });
}
