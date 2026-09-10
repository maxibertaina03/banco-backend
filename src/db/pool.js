const { Pool } = require('pg');
const env = require('../config/env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20,                        // máximo conexiones simultáneas en el pool
  idleTimeoutMillis: 30_000,      // cerrar conexiones idle después de 30s
  connectionTimeoutMillis: 30_000, // Supabase puede tardar en dar conexión, especialmente en cold start
  application_name: 'banco-backend',
});

// Capturar errores en clientes idle para evitar que el proceso crashee sin aviso.
// Lazy require de logger: pool.js es de los primeros módulos en cargarse y no
// queremos un ciclo accidental durante el bootstrap.
pool.on('error', (err) => {
  const logger = require('../utils/logger');
  logger.error({ err, subsystem: 'pool' }, 'unexpected error on idle pg client');
});

module.exports = pool;
