const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const authRouter = require('./modules/auth-router');
const notFound = require('./middlewares/not-found');
const errorHandler = require('./middlewares/error-handler');

const app = express();

app.use(cors());
app.use(express.json());

// Rutas de autenticación (públicas)
app.use('/auth', authRouter);

// Rutas del API (requieren autenticación opcional para algunos endpoints)
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
