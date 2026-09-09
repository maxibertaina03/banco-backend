function errorHandler(error, _req, res, _next) {
  if (error.code && typeof error.code === 'string' && (/^(23|42)/.test(error.code) || error.code === '42703')) {
    return res.status(400).json({
      error: 'Error de base de datos.',
      message: error.detail || error.message,
      code: error.code,
    });
  }

  const status = error.status || 500;

  return res.status(status).json({
    error: status === 500 ? 'Error interno del servidor.' : error.message,
    details: error.details || null,
  });
}

module.exports = errorHandler;
