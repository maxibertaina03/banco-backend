// Chequeo crediticio contra la central de deudores del Banco Central.
//
// Una sola función, usada en los dos lugares donde importa: al abrir una cuenta
// y al otorgar un préstamo. Decisión de equipo: situación 3 o peor bloquea las
// dos cosas.
//
// La escala es la del BCRA, y la que devuelve el Central es la PEOR de todas las
// deudas informadas por cualquier banco. Si un banco informó 1 y otro 4, es 4.
//
// Patrón factory con inyección de dependencias, igual que `transacciones-service`
// y `auth-service`. No es capricho: vitest no intercepta los `require` internos
// de un módulo CJS ni con `vi.mock` ni con `spyOn`, así que inyectar es la única
// forma de testear esto sin pegarle al Banco Central de verdad. El
// `module.exports` por defecto es una instancia real, así que quien lo consume
// no cambia.

const HttpError = require('../utils/http-error');
const realLogger = require('../utils/logger');
const realCentralBankService = require('./central-bank-service');

const SITUACIONES = {
  1: 'Normal',
  2: 'Riesgo bajo',
  3: 'Riesgo medio',
  4: 'Riesgo alto de insolvencia',
  5: 'Irrecuperable',
};

// A partir de acá no se opera. Es el umbral acordado con Gonza.
const SITUACION_MINIMA_BLOQUEANTE = 3;

function createRiesgoCrediticio({
  centralBankService = realCentralBankService,
  logger = realLogger,
} = {}) {
  /**
   * Consulta la situación crediticia de un DNI.
   *
   * Detalle del contrato del Central, verificado contra el ambiente `test`: su
   * documentación dice que devuelve 404 para un DNI que no figura, pero en la
   * práctica contesta 200 con `situacion: 1` y `deudas: []`. O sea que no se
   * puede distinguir "no existe" de "está al día". Da igual para lo que
   * necesitamos, porque la decisión se toma sobre `situacion`.
   *
   * @returns {Promise<{situacion, descripcion, deudas, bancos_acreedores}>}
   */
  async function consultarSituacion(dni, environment) {
    const datos = await centralBankService.consultarSituacionCrediticia(dni, environment);

    const situacion = Number(datos?.situacion) || 1;
    const deudas = Array.isArray(datos?.deudas) ? datos.deudas : [];

    return {
      situacion,
      descripcion: SITUACIONES[situacion] || 'Desconocida',
      deudas,
      // Cuántos bancos le prestaron. No se expone cuáles: es dato de ellos.
      bancos_acreedores: new Set(deudas.map((d) => d?.entidad).filter(Boolean)).size,
    };
  }

  /**
   * Verifica que el titular pueda operar, y tira 403 si no.
   *
   * **Si el Banco Central no responde, se deja pasar.** Es deliberado: la central
   * de deudores es una protección secundaria, y dejar a todos los clientes sin
   * poder abrir cuentas ni pedir préstamos porque una API de terceros está caída
   * es peor que otorgarle un crédito de más a alguien. Queda el warn en el log.
   *
   * @param {string} dni
   * @param {string} operacion  Qué se está intentando, para el mensaje de error.
   * @param {string} [environment]
   */
  async function verificarPuedeOperar(dni, operacion, environment) {
    let resultado;

    try {
      resultado = await consultarSituacion(dni, environment);
    } catch (error) {
      logger.warn(
        { err: error, dni, operacion, subsystem: 'riesgo-crediticio' },
        'no se pudo consultar la central de deudores, se continúa sin el chequeo'
      );
      return { verificado: false, situacion: null };
    }

    if (resultado.situacion >= SITUACION_MINIMA_BLOQUEANTE) {
      throw new HttpError(
        403,
        `No se puede ${operacion}: el titular registra situación ${resultado.situacion} ` +
          `(${resultado.descripcion}) en la central de deudores.`,
        { situacion: resultado.situacion, bancos_acreedores: resultado.bancos_acreedores }
      );
    }

    return { verificado: true, situacion: resultado.situacion };
  }

  return { consultarSituacion, verificarPuedeOperar };
}

const servicioPorDefecto = createRiesgoCrediticio();

module.exports = {
  consultarSituacion: servicioPorDefecto.consultarSituacion,
  verificarPuedeOperar: servicioPorDefecto.verificarPuedeOperar,
  createRiesgoCrediticio,
  SITUACIONES,
  SITUACION_MINIMA_BLOQUEANTE,
};
