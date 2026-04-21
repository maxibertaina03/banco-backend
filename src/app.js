const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const authRouter = require('./modules/auth-router');
const { clerkAuth } = require('./middlewares/clerk-auth');
const requireActiveUser = require('./middlewares/require-active-user');
const requireCompleteProfile = require('./middlewares/require-complete-profile');
const notFound = require('./middlewares/not-found');
const errorHandler = require('./middlewares/error-handler');

const app = express();

app.use(cors());
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
