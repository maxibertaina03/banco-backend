const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');
const logger = require('./utils/logger');

async function startServer() {
  await pool.query('SELECT 1');

  app.listen(env.port, () => {
    logger.info({ port: env.port, env: env.nodeEnv }, 'API bancaria escuchando');
  });
}

startServer().catch((error) => {
  logger.fatal({ err: error }, 'no se pudo iniciar el servidor');
  process.exit(1);
});
