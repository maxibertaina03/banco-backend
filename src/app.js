const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const notFound = require('./middlewares/not-found');
const errorHandler = require('./middlewares/error-handler');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
