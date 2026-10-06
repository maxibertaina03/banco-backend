const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');
const logger = require('./utils/logger');
const { iniciarSincronizadorEntrantes } = require('./modules/sincronizador-entrantes');
const { iniciarVencedorDeCobros } = require('./modules/vencedor-de-cobros');

async function startServer() {
  await pool.query('SELECT 1');

  const server = app.listen(env.port, () => {
    logger.info({ port: env.port, env: env.nodeEnv }, 'API bancaria escuchando');
  });

  // Las tareas de fondo. SINCRONIZAR_ENTRANTES=false las apaga todas: si
  // algún día hay dos backends contra la misma base, alcanza con que uno traiga
  // las transferencias de otros bancos y venza los QR.
  if (process.env.SINCRONIZAR_ENTRANTES !== 'false') {
    iniciarSincronizadorEntrantes();
    iniciarVencedorDeCobros();
    logger.info(
      { subsystem: 'tareas' },
      'tareas de fondo activas: entrantes cada 15 minutos, vencimiento de QR cada 10'
    );
  }

  configurarApagadoOrdenado(server);
}

/**
 * Apagado ordenado.
 *
 * Docker manda SIGTERM y espera 10 segundos antes del kill. Sin esto, un
 * `docker compose restart` corta la conexión en medio de una transferencia:
 * el cliente ve un error de red sin saber si la plata se movió o no. Con esto
 * el server deja de aceptar conexiones nuevas, termina las que están en curso
 * y recién ahí cierra el pool de Postgres.
 *
 * Si a los 8 segundos algo sigue colgado, se sale igual: es preferible cortar
 * a quedarse esperando hasta que Docker mate el proceso de todas formas.
 */
function configurarApagadoOrdenado(server) {
  let apagando = false;

  const apagar = async (senal) => {
    if (apagando) return;
    apagando = true;
    logger.info({ senal }, 'apagando: no se aceptan requests nuevas');

    const plazo = setTimeout(() => {
      logger.warn('el apagado ordenado tardó demasiado, saliendo igual');
      process.exit(1);
    }, 8000);
    plazo.unref();

    try {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await pool.end();
      logger.info('apagado limpio');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error durante el apagado');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}

startServer().catch((error) => {
  logger.fatal({ err: error }, 'no se pudo iniciar el servidor');
  process.exit(1);
});
