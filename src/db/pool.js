const { Pool } = require('pg');
const env = require('../config/env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  // Conexiones simultáneas. Contra el pooler de Supabase en plan gratis, 20 era
  // demasiado para lo que este banco necesita: 10 alcanza y deja lugar a las
  // otras conexiones del proyecto. DB_POOL_MAX lo sube si algún día hace falta.
  max: Number(process.env.DB_POOL_MAX || 10),
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
