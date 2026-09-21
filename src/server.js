const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');
const logger = require('./utils/logger');
const { iniciarSincronizadorEntrantes } = require('./modules/sincronizador-entrantes');

async function startServer() {
  await pool.query('SELECT 1');

  app.listen(env.port, () => {
    logger.info({ port: env.port, env: env.nodeEnv }, 'API bancaria escuchando');
  });

  // Transferencias de otros bancos, de fondo. SINCRONIZAR_ENTRANTES=false lo
  // apaga (por ejemplo, para correr un segundo backend contra la misma base).
  if (process.env.SINCRONIZAR_ENTRANTES !== 'false') {
    iniciarSincronizadorEntrantes();
    logger.info({ subsystem: 'sincronizador' }, 'sincronización de entrantes activa cada 15 minutos');
  }
}

startServer().catch((error) => {
  logger.fatal({ err: error }, 'no se pudo iniciar el servidor');
  process.exit(1);
});
