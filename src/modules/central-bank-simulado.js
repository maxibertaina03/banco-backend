const crypto = require('node:crypto');
const HttpError = require('../utils/http-error');

/**
 * El Banco Central, de mentira. Sólo para las sesiones demo.
 *
 * La cátedra pide que el usuario de prueba pueda transferir a otro banco "sin
 * que impacte en el dinero real o en algo del banco". El Central es compartido
 * con todo el curso: una transferencia de verdad queda registrada allá. Así que
 * para el demo se sustituye por esto, que responde lo mismo sin salir a
 * internet.
 *
 * Implementa la misma superficie que usa el camino de transferencias de
 * `central-bank-service.js`, con las mismas formas de respuesta: los
 * extractores `extraerIdTransaccionCentral` y `extractCentralCbu` de
 * `central-bank/central-bank-helpers.js` recorren el payload buscando
 * `transaction_id`/`id` y `cbu` en cualquier nivel, así que alcanza con
 * devolverlos arriba de todo.
 *
 * Lo que NO hace, a propósito: llevar estado. Cada llamada se contesta sola.
 * El estado del demo vive donde vive el de cualquier cliente, en la base.
 */

/** Los tres primeros dígitos del CBU dicen de qué banco es. 006 somos nosotros. */
const CODIGO_BANCO_ORBITAL = '006';

/** Un id que no se pueda confundir con uno del Central de verdad. */
function idSimulado(prefijo) {
  return `${prefijo}-${crypto.randomUUID()}`;
}

/**
 * Transferencia saliente.
 *
 * Devuelve siempre aprobada. El control de saldo ya lo hizo el banco antes de
 * llegar acá (`UPDATE … WHERE saldo >= $1`), así que rechazar por fondos sería
 * redundante; y el 422 del Central real se traduce a "rechazada", un camino que
 * en el demo sólo confundiría.
 */
async function crearTransaccion(payload, _environment, { includeResponseMeta = false } = {}) {
  const transaccion = {
    transaction_id: idSimulado('demo-tx'),
    cbu: payload?.cbuDestino ?? null,
    cbu_origen: payload?.cbuOrigen ?? null,
    importe: payload?.importe ?? null,
    estado: 'aprobada',
    simulada: true,
    fecha: new Date().toISOString(),
  };

  return includeResponseMeta ? { data: transaccion, status: 201 } : transaccion;
}

/**
 * Quién es el dueño de un CBU.
 *
 * El Central real devuelve 404 si no lo conoce, y el portal muestra "no
 * encontramos esa cuenta". Acá cualquier CBU con forma válida existe: el
 * visitante tiene que poder tipear 22 dígitos cualesquiera y que le funcione.
 */
async function findPersonByCbu(cbu, _environment) {
  if (!/^\d{22}$/.test(String(cbu || ''))) {
    throw new HttpError(404, 'No encontramos esa cuenta.');
  }
  return {
    cbu: String(cbu),
    nombre: 'Cuenta',
    apellido: 'de prueba',
    titular: 'Cuenta de prueba',
    banco: nombreDeBancoSimulado(String(cbu)),
    simulada: true,
  };
}

async function findPersonByAlias(alias, _environment) {
  const limpio = String(alias || '').trim();
  if (limpio.length < 6) {
    throw new HttpError(404, 'No encontramos ese alias.');
  }
  // Un CBU con forma válida para que el resto del circuito no se entere de que
  // es inventado: 006 adelante haría que el banco lo tome por interno.
  return {
    cbu: `008${String(Math.abs(hash(limpio))).padStart(19, '0').slice(0, 19)}`,
    alias: limpio,
    titular: 'Cuenta de prueba',
    simulada: true,
  };
}

async function getBankByCode(code, _environment) {
  return { code: String(code), nombre: nombreDeBancoSimulado(String(code).padEnd(3, '0')) };
}

async function buscarCuentaPorCbu(cbu, _environment) {
  return findPersonByCbu(cbu, _environment);
}

/**
 * Apertura de cuenta. El Central real es quien asigna el CBU; acá se genera uno
 * local con prefijo de Orbital, igual que hace `generateCbu` en
 * relations-router cuando el Central no responde.
 */
async function abrirCuentaCentral({ dni, moneda } = {}, _environment) {
  const resto = `${String(dni || '').padStart(8, '0')}${Date.now()}`.slice(-19);
  return {
    cbu: `${CODIGO_BANCO_ORBITAL}${resto}`,
    alias: null,
    moneda: moneda || 'ARS',
    simulada: true,
  };
}

/**
 * Situación en la Central de Deudores.
 *
 * Siempre 1, "normal, sin atrasos". Es lo que hace que el visitante pueda pedir
 * un préstamo y que se lo aprueben solo: con situación 3 o peor caería a la
 * bandeja del gerente y se quedaría esperando a que una persona real lo mire.
 */
async function consultarSituacionCrediticia(_dni, _environment) {
  return { situacion: 1, deudas: [], simulada: true };
}

/** Informar deuda al Central no tiene sentido para una persona que no existe. */
async function informarDeuda(_payload, _environment) {
  return { ok: true, simulada: true };
}

function nombreDeBancoSimulado(cbu) {
  const codigo = String(cbu).slice(0, 3);
  if (codigo === CODIGO_BANCO_ORBITAL) return 'Banco Orbital';
  return 'Banco de prueba';
}

function hash(texto) {
  let h = 0;
  for (let i = 0; i < texto.length; i += 1) {
    h = (h * 31 + texto.charCodeAt(i)) | 0;
  }
  return h;
}

module.exports = {
  abrirCuentaCentral,
  buscarCuentaPorCbu,
  consultarSituacionCrediticia,
  crearTransaccion,
  findPersonByAlias,
  findPersonByCbu,
  getBankByCode,
  informarDeuda,
  idSimulado,
};
