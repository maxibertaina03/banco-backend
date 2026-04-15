const app = require('./app');
const env = require('./config/env');
const pool = require('./db/pool');

async function startServer() {
  await pool.query('SELECT 1');

  app.listen(env.port, () => {
    console.log(`API bancaria escuchando en http://localhost:${env.port}`);
  });
}

startServer().catch((error) => {
  console.error('No se pudo iniciar el servidor:', error.message);
  process.exit(1);
});
