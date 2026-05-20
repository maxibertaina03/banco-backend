const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const authRouter = require('./modules/auth-router');
const clerkWebhookRouter = require('./modules/clerk-webhook-router');
const { clerkAuth } = require('./middlewares/clerk-auth');
const requireActiveUser = require('./middlewares/require-active-user');
const requireCompleteProfile = require('./middlewares/require-complete-profile');
const notFound = require('./middlewares/not-found');
const errorHandler = require('./middlewares/error-handler');
const env = require('./config/env');

const app = express();

app.use(cors({
  origin: env.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// El webhook necesita el body crudo para verificar la firma de Clerk.
app.use('/webhooks/clerk', clerkWebhookRouter);

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'banco-backend',
  });
});

// Rutas de autenticación y onboarding
app.use('/auth', authRouter);

// Rutas del API protegidas para usuarios autenticados, activos y con perfil completo
app.use('/api', clerkAuth, requireActiveUser, requireCompleteProfile, routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
