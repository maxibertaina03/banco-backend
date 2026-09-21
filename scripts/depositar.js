// Carga dinero en la cuenta de una persona, como un depósito en ventanilla.
//
//   npm run depositar -- <dni> <ARS|USD> <monto> [--abrir]
//   npm run depositar -- 44673782 ARS 1000000
//   npm run depositar -- 44673782 USD 1000 --abrir
//
// Pasa por el mismo depósito que usa el banco (`crearDeposito`), no por un
// UPDATE directo: así queda el movimiento en el extracto del titular, que es la
// regla del sistema ("si el saldo cambia, hay un movimiento").
//
// `--abrir` abre la caja si la persona no tiene una en esa moneda. La abre por
// el circuito normal, que la registra en el Banco Central; sin el flag, el
// script avisa y no crea nada.
//
// Es para cargar saldo de prueba antes de una demo. No corre en producción.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

if (process.env.NODE_ENV === 'production') {
  console.error('Este script no corre con NODE_ENV=production: es para cargar saldo de prueba.');
  process.exit(1);
}

const pool = require('../src/db/pool');
const { crearDeposito } = require('../src/modules/transacciones-service');
const { abrirCuenta } = require('../src/modules/cuentas-service');

function leerArgumentos() {
  const args = process.argv.slice(2);
  const abrir = args.includes('--abrir');
  const [dni, monedaCruda, montoCrudo] = args.filter((a) => !a.startsWith('--'));
  const moneda = String(monedaCruda || '').toUpperCase();
  const monto = parsearMonto(montoCrudo);

  if (!dni || !['ARS', 'USD'].includes(moneda) || !Number.isFinite(monto) || monto <= 0) {
    console.error('Uso: npm run depositar -- <dni> <ARS|USD> <monto> [--abrir]');
    console.error('Ej.: npm run depositar -- 44673782 USD 1000 --abrir');
    process.exit(1);
  }
  return { dni, moneda, monto, abrir };
}

/**
 * Convención argentina, igual que el portal: el punto separa miles y la coma,
 * decimales. "1.000.000" es un millón, "1000,50" y "1000.50" son mil con 50.
 * Cualquier otra cosa es inválida: con plata es mejor rechazar que adivinar.
 */
function parsearMonto(texto) {
  const t = String(texto || '').trim();
  let normalizado;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) normalizado = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+([.,]\d{1,2})?$/.test(t)) normalizado = t.replace(',', '.');
  else return NaN;
  return Number(normalizado);
}

const formato = (monto, moneda) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: moneda }).format(Number(monto));

async function main() {
  const { dni, moneda, monto, abrir } = leerArgumentos();

  const p = await pool.query('SELECT id, nombre, apellido FROM personas WHERE dni = $1', [dni]);
  if (p.rowCount === 0) throw new Error(`No hay ninguna persona con DNI ${dni}.`);
  if (p.rowCount > 1) throw new Error(`Hay ${p.rowCount} personas con DNI ${dni}: resolvelo antes de cargar saldo.`);
  const persona = p.rows[0];
  console.log(`${persona.nombre} ${persona.apellido} (DNI ${dni})`);

  let c = await pool.query(
    'SELECT id, cbu, saldo FROM cuentas WHERE persona_id = $1 AND moneda = $2 AND activa = TRUE ORDER BY created_at LIMIT 1',
    [persona.id, moneda]
  );

  if (c.rowCount === 0) {
    if (!abrir) {
      throw new Error(`No tiene caja activa en ${moneda}. Repetí con --abrir para abrirla.`);
    }
    // Sin usuario: es una llamada interna, como la haría un operador del banco.
    const { cuenta } = await abrirCuenta({ personaId: persona.id, moneda });
    console.log(`  abrí la caja en ${moneda}, CBU ${cuenta.cbu}`);
    c = await pool.query('SELECT id, cbu, saldo FROM cuentas WHERE id = $1', [cuenta.id]);
  }

  const cuenta = c.rows[0];
  console.log(`  caja en ${moneda}, CBU ${cuenta.cbu}: ${formato(cuenta.saldo, moneda)}`);

  await crearDeposito({
    cuenta_destino_id: cuenta.id,
    monto,
    descripcion: 'Depósito de saldo de prueba',
  });

  const despues = await pool.query('SELECT saldo FROM cuentas WHERE id = $1', [cuenta.id]);
  console.log(`  + ${formato(monto, moneda)} → ${formato(despues.rows[0].saldo, moneda)}`);
}

main()
  .catch((error) => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
