const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const routes = require('./routes');
const authRouter = require('./modules/auth-router');
const clerkWebhookRouter = require('./modules/clerk-webhook-router');
const { clerkAuth } = require('./middlewares/clerk-auth');
const requireActiveUser = require('./middlewares/require-active-user');
const requireCompleteProfile = require('./middlewares/require-complete-profile');
const notFound = require('./middlewares/not-found');
const errorHandler = require('./middlewares/error-handler');
const env = require('./config/env');
const logger = require('./utils/logger');

const app = express();

// ── Request logging ─────────────────────────────────────────────────────────
// pino-http inyecta `req.log` con un child logger que ya tiene `req.id`
// (UUID por request), method y url. Cada handler puede hacer
// `req.log.info({ ... }, 'mensaje')` para emitir logs estructurados que se
// correlacionan automáticamente. La línea de finalización (status + tiempo)
// la emite el propio middleware al cerrar la response.
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} → ${res.statusCode} (${err?.message || 'error'})`,
    // No loguear health checks: ruido sin valor.
    autoLogging: {
      ignore: (req) => req.url === '/api/health',
    },
  })
);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      objectSrc:  ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31_536_000,
    includeSubDomains: true,
    preload: true,
  },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: env.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['Idempotent-Replay'],
}));

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Límite global: 300 req / 15 min por IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá de nuevo en unos minutos.' },
});

// Límite estricto para auth: 20 req / 15 min por IP (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Esperá 15 minutos.' },
});

app.use(globalLimiter);

// ── Webhook: body crudo para verificar firma de Clerk ─────────────────────────
app.use('/webhooks/clerk', clerkWebhookRouter);

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
const pool = require('./db/pool');
const asyncHandler = require('./utils/async-handler');

app.get('/api/health', asyncHandler(async (_req, res) => {
  const start = Date.now();
  await pool.query('SELECT 1');
  res.json({
    ok: true,
    service: 'banco-backend',
    db: 'connected',
    latencyMs: Date.now() - start,
    ts: new Date().toISOString(),
  });
}));

// ── Auth (con límite estricto) ─────────────────────────────────────────────────
app.use('/auth', authLimiter, authRouter);

// ── API protegida ─────────────────────────────────────────────────────────────
app.use('/api', clerkAuth, requireActiveUser, requireCompleteProfile, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
