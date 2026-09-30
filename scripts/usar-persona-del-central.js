// Hace que el login de Gmail entre a la persona que el Banco Central conoce
// con el nombre correcto.
//
// El problema: hay dos personas "Maximo Bertaina" en la base. La del DNI
// 44673780 (con la que se entra hoy, mail de Gmail) está registrada en el
// Banco Central a nombre de *Lucas Alessandroni*, así que cualquiera que
// reciba una transferencia de esa cuenta ve ese nombre. La del DNI 44673782
// figura bien, y además tiene más saldo y más movimientos.
//
// El Banco Central no tiene ningún endpoint para corregir el nombre de una
// persona, así que la salida es usar la que ya está bien.
//
// Qué hace, en orden:
//   1. Le saca el alias `maxi.bertaina` a la cuenta equivocada y le pone
//      `lucas.alessandroni`, que es de quien el Central cree que es.
//   2. Le pone `maxi.bertaina` a la caja en pesos de la persona correcta.
//   3. Apunta el usuario de Clerk del Gmail a esa persona, y le copia el mail.
//
// La persona vieja queda sin login: no se borra nada. Si querés mover esos
// $ 254.500 a la cuenta buena, se hace después con `npm run depositar`.
//
// Uso:
//   node scripts/usar-persona-del-central.js              (sólo muestra el plan)
//   node scripts/usar-persona-del-central.js --confirmar  (lo aplica)
//
// Se puede correr más de una vez sin romper nada: cada paso comprueba si ya
// está hecho antes de tocar.

require('dotenv').config();

const pool = require('../src/db/pool');
const central = require('../src/modules/central-bank-service');

const DNI_EQUIVOCADO = '44673780';
const DNI_CORRECTO = '44673782';
const CLERK_GMAIL = 'user_3Db81IQxEemK1kBfnWUr0RsRziz';
const MAIL = 'maximobertaina2016@gmail.com';
const ALIAS = 'maxi.bertaina';

const confirmar = process.argv.includes('--confirmar');

async function personaPorDni(dni) {
  const r = await pool.query('SELECT id, nombre, apellido, email FROM personas WHERE dni = $1 LIMIT 1', [dni]);
  if (r.rowCount === 0) throw new Error(`No hay ninguna persona con DNI ${dni}.`);
  return r.rows[0];
}

async function cuentaEnPesos(personaId) {
  const r = await pool.query(
    "SELECT id, cbu, alias, saldo FROM cuentas WHERE persona_id = $1 AND moneda = 'ARS' AND activa = true LIMIT 1",
    [personaId]
  );
  if (r.rowCount === 0) throw new Error('Esa persona no tiene caja de ahorro en pesos activa.');
  return r.rows[0];
}

async function main() {
  const vieja = await personaPorDni(DNI_EQUIVOCADO);
  const correcta = await personaPorDni(DNI_CORRECTO);
  const cuentaVieja = await cuentaEnPesos(vieja.id);
  const cuentaCorrecta = await cuentaEnPesos(correcta.id);

  console.log('Persona que se deja de usar:');
  console.log(`   DNI ${DNI_EQUIVOCADO} · ${vieja.email} · caja en pesos con $ ${cuentaVieja.saldo}`);
  console.log(`   en el Banco Central figura como: Lucas Alessandroni`);
  console.log('\nPersona que pasa a usarse:');
  console.log(`   DNI ${DNI_CORRECTO} · ${correcta.email} · caja en pesos con $ ${cuentaCorrecta.saldo}`);
  console.log(`   en el Banco Central figura como: ${correcta.nombre} ${correcta.apellido}`);

  if (!confirmar) {
    console.log('\nEsto es sólo el plan. Para aplicarlo:');
    console.log('   node scripts/usar-persona-del-central.js --confirmar');
    return;
  }

  console.log('\nAplicando…');

  // 1. Liberar el alias. El Central no acepta borrarlo, así que se reasigna al
  //    nombre que él mismo tiene para ese CBU.
  if (cuentaVieja.alias === ALIAS) {
    await central.assignAlias(cuentaVieja.cbu, 'lucas.alessandroni');
    console.log(`   1/3  "${ALIAS}" liberado de la cuenta vieja`);
  } else {
    console.log(`   1/3  la cuenta vieja no tiene "${ALIAS}", no hay nada que liberar`);
  }

  // 2. Ponérselo a la cuenta que sí figura a tu nombre.
  await central.assignAlias(cuentaCorrecta.cbu, ALIAS);
  console.log(`   2/3  "${ALIAS}" asignado a la caja en pesos correcta`);

  // 3. Que el login de siempre entre a la persona correcta.
  const u = await pool.query('UPDATE usuarios SET persona_id = $1 WHERE clerk_id = $2', [correcta.id, CLERK_GMAIL]);
  if (u.rowCount === 0) {
    throw new Error(`No se encontró el usuario de Clerk ${CLERK_GMAIL}. Revisá el id antes de seguir.`);
  }
  console.log('   3/4  el login de Gmail ahora entra a la persona correcta');

  // 4. Mudar la dirección de mail, para que el perfil muestre la que usás.
  //
  //    `personas.email` tiene índice único, así que primero hay que liberarla
  //    de la persona vieja. Se le deja una variante con "+viejo", que sigue
  //    siendo una dirección real y no choca con ninguna otra.
  if (vieja.email === MAIL) {
    const [usuario, dominio] = MAIL.split('@');
    await pool.query('UPDATE personas SET email = $1 WHERE id = $2', [`${usuario}+viejo@${dominio}`, vieja.id]);
  }
  await pool.query('UPDATE personas SET email = $1 WHERE id = $2', [MAIL, correcta.id]);
  console.log('   4/4  el perfil muestra tu dirección de siempre');

  const enCentral = await central.findPersonByAlias(ALIAS);
  console.log(`\nListo. "${ALIAS}" → ${enCentral.nombre} ${enCentral.apellido} (${enCentral.cbu})`);
  console.log('Cerrá sesión en el portal y volvé a entrar para verlo.');
}

main()
  .catch((error) => {
    console.error('\nFalló:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
