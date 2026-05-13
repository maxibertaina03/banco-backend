const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('Falta la variable DATABASE_URL en .env para ejecutar el setup de base de datos.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const rootDir = path.resolve(__dirname, '..');
const schemaPath = path.join(rootDir, 'schema.sql');
const seedPath = path.join(rootDir, 'seed.sql');

function parseMode() {
  const mode = process.argv[2] || 'all';
  const validModes = new Set(['all', 'schema', 'seed']);

  if (!validModes.has(mode)) {
    throw new Error(
      `Modo no valido: ${mode}. Usa uno de estos valores: all, schema, seed.`
    );
  }

  return mode;
}

async function runSqlFile(client, filePath, label) {
  const sql = await fs.readFile(filePath, 'utf8');

  if (!sql.trim()) {
    throw new Error(`El archivo ${label} esta vacio.`);
  }

  console.log(`\n> Ejecutando ${label}...`);
  await client.query(sql);
  console.log(`> ${label} ejecutado correctamente.`);
}

async function main() {
  const mode = parseMode();
  const client = await pool.connect();

  try {
    if (mode === 'seed') {
      await runSqlFile(client, seedPath, 'seed.sql');
      return;
    }

    await runSqlFile(client, schemaPath, 'schema.sql');

    if (mode === 'all') {
      await runSqlFile(client, seedPath, 'seed.sql');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\nBase de datos preparada.');
  })
  .catch((error) => {
    console.error('\nNo se pudo preparar la base de datos.');
    console.error(error.message);
    process.exitCode = 1;
  });
