const logger = require('../utils/logger');

const isProd = process.env.NODE_ENV === 'production';

function errorHandler(error, req, res, _next) {
  // Preferimos `req.log` (child logger con request-id inyectado por pino-http);
  // si no está disponible (test, llamada sintética), caemos al logger raíz.
  const log = req?.log || logger;

  // DB constraint errors — nunca exponer detail de PostgreSQL en producción
  if (error.code && typeof error.code === 'string' && error.code.startsWith('23')) {
    log.warn(
      { err: error, code: error.code, detail: error.detail, route: req?.originalUrl },
      'db constraint violation'
    );
    return res.status(400).json({
      error: 'Error de validación de datos.',
      ...(isProd ? {} : { detail: error.detail, code: error.code }),
    });
  }

  const status = error.status || 500;
  const isServerError = status >= 500;

  // Logging por severidad: 5xx = error (bug en el server), 4xx = warn (input
  // del cliente o estado esperado). 4xx no es ruido a investigar.
  if (isServerError) {
    log.error({ err: error, status, route: req?.originalUrl }, 'unhandled server error');
  } else {
    log.warn({ status, message: error.message, route: req?.originalUrl }, 'client error');
  }

  // En producción: mensajes genéricos para 5xx para no filtrar internos
  const message = isServerError && isProd
    ? 'Error interno del servidor.'
    : (error.message || 'Error interno del servidor.');

  // details solo se expone en desarrollo, o para errores 4xx que el cliente
  // necesita conocer (e.g. validación de Zod con fieldErrors)
  const details = (!isProd || !isServerError) ? (error.details ?? null) : null;

  return res.status(status).json({
    error: message,
    ...(details !== null && { details }),
  });
}

module.exports = errorHandler;
