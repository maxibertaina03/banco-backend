// Resolución y validación de monedas entre cuentas.
//
// Por qué existe este módulo: **el Banco Central no valida monedas**. Su
// `POST /transactions` no tiene campo `moneda`, así que acepta una transferencia
// desde un CBU en pesos hacia uno en dólares y mueve el `importe` tal cual, sin
// convertir nada. Si otro banco nos manda 50.000 desde una caja en pesos a
// nuestro CBU en dólares, acreditaríamos 50.000 dólares.
//
// El problema está planteado en el grupo de bancos, pero mientras tanto la
// defensa es nuestra y va en los dos sentidos: al enviar y al recibir.
//
// Cómo se resuelve la moneda de un CBU ajeno: con `GET /accounts/{cbu}` del
// Banco Central, que devuelve `moneda`. Su documentación dice que ese endpoint
// sólo encuentra cuentas en monedas distintas de ARS, pero al probarlo contra el
// ambiente `test` resuelve las dos. Verificado el 8/9/2026.

const HttpError = require('../utils/http-error');
const realCentralBankService = require('./central-bank-service');
const realLogger = require('../utils/logger');
const { createTTLCache } = require('../utils/ttl-cache');

const MONEDA_POR_DEFECTO = 'ARS';

function createMonedas({
  centralBankService = realCentralBankService,
  logger = realLogger,
  // La moneda de un CBU no cambia nunca, así que se puede cachear con holgura.
  // 500 entradas y 30 minutos alcanzan para una tanda de transferencias sin
  // pegarle al Central por cada una.
  cache = createTTLCache(500, 30 * 60_000),
} = {}) {
  /**
   * Moneda de un CBU cualquiera, propio o de otro banco.
   *
   * Si el Banco Central no responde, devuelve `null` en vez de tirar: quien
   * llama decide si eso alcanza para seguir. Se prefiere no romper la
   * transferencia por una consulta accesoria.
   */
  async function resolverMonedaDeCbu(cbu, environment) {
    if (!cbu) return null;

    const cacheada = cache.get(cbu);
    if (cacheada) return cacheada;

    try {
      const cuenta = await centralBankService.buscarCuentaPorCbu(cbu, environment);
      const moneda = cuenta?.moneda || null;
      if (moneda) cache.set(cbu, moneda);
      return moneda;
    } catch (error) {
      // 404 es una respuesta legítima: el CBU no existe en el Central. No es un
      // fallo de red y no tiene sentido loguearlo como problema.
      if (error?.status !== 404) {
        logger.warn(
          { err: error, cbu, subsystem: 'monedas' },
          'no se pudo resolver la moneda del CBU en el Banco Central'
        );
      }
      return null;
    }
  }

  /**
   * Verifica que dos cuentas puedan transferirse entre sí, y tira 400 si no.
   *
   * **Si no se pudo determinar la moneda del destino, se deja pasar.** Es la
   * misma lógica que el chequeo crediticio: una consulta accesoria caída no
   * puede dejar al banco sin poder transferir. Queda el warn en el log.
   *
   * @param {string} monedaOrigen  Moneda de la cuenta local de origen, que siempre conocemos.
   * @param {string} cbuDestino
   */
  async function validarMonedasCompatibles(monedaOrigen, cbuDestino, environment) {
    const origen = monedaOrigen || MONEDA_POR_DEFECTO;
    const destino = await resolverMonedaDeCbu(cbuDestino, environment);

    if (destino === null) {
      logger.warn(
        { cbuDestino, monedaOrigen: origen, subsystem: 'monedas' },
        'no se pudo verificar la moneda del destino, la transferencia continúa'
      );
      return { verificado: false, monedaOrigen: origen, monedaDestino: null };
    }

    if (destino !== origen) {
      throw new HttpError(
        400,
        `La cuenta de origen es ${origen} y la de destino es ${destino}. ` +
          'No se puede transferir entre monedas distintas. Para cambiar de moneda, usá la compra y venta de dólares.',
        { moneda_origen: origen, moneda_destino: destino }
      );
    }

    return { verificado: true, monedaOrigen: origen, monedaDestino: destino };
  }

  /**
   * Igual que la anterior pero para lo que **entra**: una transferencia que otro
   * banco nos manda. Acá no se puede rechazar la operación, porque el dinero ya
   * salió del otro lado; lo que se hace es no acreditar y dejar constancia, que
   * es mejor que acreditar dólares con un importe en pesos.
   *
   * @returns {Promise<{acreditable: boolean, motivo: string|null}>}
   */
  async function validarEntrante(cbuOrigen, monedaCuentaDestino, environment) {
    const origen = await resolverMonedaDeCbu(cbuOrigen, environment);
    const destino = monedaCuentaDestino || MONEDA_POR_DEFECTO;

    if (origen === null) {
      // No se pudo verificar: se acredita igual. Es lo que se venía haciendo
      // antes de que existieran las cuentas en dólares.
      return { acreditable: true, motivo: null };
    }

    if (origen !== destino) {
      return {
        acreditable: false,
        motivo:
          `El origen es ${origen} y la cuenta de destino es ${destino}. ` +
          'No se acredita para no convertir un importe entre monedas sin cotización.',
      };
    }

    return { acreditable: true, motivo: null };
  }

  return { resolverMonedaDeCbu, validarMonedasCompatibles, validarEntrante };
}

const servicioPorDefecto = createMonedas();

module.exports = {
  resolverMonedaDeCbu: servicioPorDefecto.resolverMonedaDeCbu,
  validarMonedasCompatibles: servicioPorDefecto.validarMonedasCompatibles,
  validarEntrante: servicioPorDefecto.validarEntrante,
  createMonedas,
  MONEDA_POR_DEFECTO,
};
