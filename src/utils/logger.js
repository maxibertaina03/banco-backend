const pino = require('pino');
const env = require('../config/env');

// Logger estructurado del backend. En desarrollo usa `pino-pretty` para
// salida coloreada y legible; en producción produce JSON puro (ideal para
// CloudWatch / Datadog / Loki / etc).
//
// Niveles:
//   - error: lo que rompe el flujo (excepciones, fallos de BD)
//   - warn:  algo inesperado pero recuperable (key reused, fallback)
//   - info:  eventos de negocio significativos (transfer completada, login)
//   - debug: detalle interno (queries SQL, payloads); silenciado en prod
//
// Uso:
//   const logger = require('./utils/logger');
//   logger.info({ usuarioId, monto }, 'transfer aprobada');
//
// Dentro de un request HTTP, preferí `req.log` (pino-http inyecta un child
// logger con `req.id`, `req.method`, `req.url` automáticamente).

const isDev = (env.nodeEnv || process.env.NODE_ENV || 'development') !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),

  // Redact: nunca loguear secretos aunque alguien los pase en context.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["idempotency-key"]',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.secret',
      '*.dni',
    ],
    censor: '[REDACTED]',
  },

  // En dev: salida bonita. En prod: JSON una línea por log.
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined,

  // Base context que aparece en cada log: identifica al servicio.
  base: {
    service: 'banco-backend',
  },
});

module.exports = logger;
