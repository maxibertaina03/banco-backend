// Cliente HTTP de las APIs públicas de mercado.
//
// Qué resuelve: son APIs de terceros, gratuitas y sin SLA. Se caen, tardan, o
// cambian el shape sin avisar. Todo eso se contiene acá para que el resto del
// backend nunca vea un timeout de DolarAPI.
//
// Tres protecciones, en este orden:
//   1. Caché TTL — la cotización no cambia cada segundo y las tasas cambian por día.
//   2. Timeout corto — más vale un valor viejo que una request colgada.
//   3. Último valor conocido — si la API falla y hay algo cacheado (aunque haya
//      expirado), se devuelve eso antes que romper la operación del cliente.
//
// El punto 3 es la razón de que la caché guarde también un "respaldo" sin
// vencimiento: el TTL decide cuándo *refrescar*, no cuándo *tirar*.

const axios = require('axios');
const logger = require('../../utils/logger');

const TIMEOUT_MS = 5_000;

// Respaldo sin vencimiento: la última respuesta buena de cada fuente. Sobrevive
// al TTL a propósito, para poder responder cuando la API externa está caída.
const ultimoValorConocido = new Map();

/**
 * Hace un GET contra una API pública y devuelve el JSON.
 *
 * Si falla y hay un valor previo, lo devuelve con `{ desdeRespaldo: true }` en vez
 * de tirar. Sólo tira si nunca hubo una respuesta buena.
 *
 * @param {string} clave  Identificador de la fuente, para el respaldo y los logs.
 * @param {string} url    URL absoluta.
 */
async function traer(clave, url) {
  try {
    const respuesta = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    ultimoValorConocido.set(clave, respuesta.data);
    return { datos: respuesta.data, desdeRespaldo: false };
  } catch (error) {
    const respaldo = ultimoValorConocido.get(clave);

    if (respaldo !== undefined) {
      logger.warn(
        { err: error, fuente: clave, subsystem: 'mercado' },
        'la API de mercado falló, se responde con el último valor conocido'
      );
      return { datos: respaldo, desdeRespaldo: true };
    }

    logger.error(
      { err: error, fuente: clave, subsystem: 'mercado' },
      'la API de mercado falló y no hay valor de respaldo'
    );
    throw error;
  }
}

/** Sólo para tests: vacía el respaldo entre casos. */
function _limpiarRespaldo() {
  ultimoValorConocido.clear();
}

module.exports = { traer, _limpiarRespaldo, TIMEOUT_MS };
