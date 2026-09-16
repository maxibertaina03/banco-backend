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

  // Un HttpError lo tiramos nosotros a propósito, con un mensaje escrito para
  // el cliente. Un Error cualquiera con status 500 es un bug. Los 5xx
  // deliberados (502 y 503 cuando un proveedor rechaza o no responde) son de la
  // primera clase: ni son un bug del server ni hay que esconderles el mensaje.
  const esDeliberado = error.name === 'HttpError';

  // Logging por severidad: un bug del server es error; un fallo de una
  // dependencia externa o un input del cliente es warn, no ruido a investigar.
  if (isServerError && !esDeliberado) {
    log.error({ err: error, status, route: req?.originalUrl }, 'unhandled server error');
  } else if (isServerError) {
    log.warn({ status, message: error.message, route: req?.originalUrl }, 'dependencia externa no disponible');
  } else {
    log.warn({ status, message: error.message, route: req?.originalUrl }, 'client error');
  }

  // En producción los 5xx inesperados se genericizan para no filtrar internos.
  // Los deliberados conservan su mensaje: "el proveedor no está disponible,
  // intentá en unos minutos" es justamente lo que el cliente necesita leer, y
  // el contrato lo documenta así.
  const message = isServerError && isProd && !esDeliberado
    ? 'Error interno del servidor.'
    : (error.message || 'Error interno del servidor.');

  // details solo se expone en desarrollo, para errores 4xx que el cliente
  // necesita conocer (e.g. validación de Zod con fieldErrors) o para los 5xx
  // que tiramos nosotros.
  const details = (!isProd || !isServerError || esDeliberado) ? (error.details ?? null) : null;

  return res.status(status).json({
    error: message,
    ...(details !== null && { details }),
  });
}

module.exports = errorHandler;
