// Apertura de cuentas multi-moneda.
//
// La caja en pesos ya existe desde que la persona se registra: la crea
// `apertura-basica` y el Banco Central la genera junto con `POST /persons`. Este
// service abre las **adicionales**, que en la práctica hoy significa la caja en
// dólares.
//
// El orden importa y no es obvio: **primero se pide el CBU al Banco Central y
// después se guarda local**. Al revés quedarían cuentas locales sin CBU válido si
// el Central rechaza, y no hay forma de arreglarlas después porque su
// `POST /accounts` genera el CBU de su lado.
//
// Patrón factory con inyección, igual que el resto de los services del proyecto.

const realPool = require('../db/pool');
const realCentralBankService = require('./central-bank-service');
const realRiesgoCrediticio = require('./riesgo-crediticio');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { generarNumeroDeCuentaLocal } = require('./central-bank/central-bank-helpers');
const HttpError = require('../utils/http-error');

const MONEDAS_VALIDAS = ['ARS', 'USD'];
const NOMBRE_TIPO_CUENTA = 'Caja de Ahorro';

function createCuentasService({
  pool = realPool,
  centralBankService = realCentralBankService,
  riesgoCrediticio = realRiesgoCrediticio,
  escribirLogDeAuditoria = realEscribirLog,
} = {}) {
  async function enTransaccionDeBd(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await fn(client);
      await client.query('COMMIT');
      return resultado;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Abre una caja de ahorro en la moneda pedida.
   *
   * Idempotente, con el mismo criterio que el Banco Central: si la persona ya
   * tiene una cuenta activa en esa moneda, se devuelve la existente con
   * `creada: false` en vez de fallar. Eso hace que reintentar sea seguro.
   *
   * @returns {Promise<{cuenta, creada: boolean}>}
   */
  async function abrirCuenta({ personaId, moneda, alias = null, usuarioActual, ipAddress, environment }) {
    if (!MONEDAS_VALIDAS.includes(moneda)) {
      throw new HttpError(400, `Moneda no soportada. Valores válidos: ${MONEDAS_VALIDAS.join(', ')}.`);
    }

    const personaResult = await pool.query(
      'SELECT id, dni, nombre, apellido FROM personas WHERE id = $1 LIMIT 1',
      [personaId]
    );
    if (personaResult.rowCount === 0) {
      throw new HttpError(404, `No existe la persona con id ${personaId}.`);
    }
    const persona = personaResult.rows[0];

    if (!persona.dni) {
      throw new HttpError(
        400,
        'La persona no tiene DNI cargado, y el Banco Central lo exige para abrir una cuenta.'
      );
    }

    // Si ya tiene una activa en esa moneda, se devuelve y no se toca nada más.
    // Se chequea antes de llamar al Central para no gastar una request de más.
    const existente = await pool.query(
      `SELECT c.*, tc.nombre AS tipo_cuenta_nombre
         FROM cuentas c
         JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
        WHERE c.persona_id = $1 AND c.moneda = $2 AND c.activa
        LIMIT 1`,
      [personaId, moneda]
    );
    if (existente.rowCount > 0) {
      return { cuenta: existente.rows[0], creada: false };
    }

    // Chequeo crediticio. Situación 3 o peor tira 403 desde acá.
    await riesgoCrediticio.verificarPuedeOperar(persona.dni, 'abrir la cuenta', environment);

    // El CBU lo genera el Banco Central, así que se le pide antes de escribir
    // nada local. Para ARS siempre devuelve 200 con el CBU que ya existe.
    const respuestaCentral = await centralBankService.abrirCuentaCentral({
      dni: persona.dni,
      moneda,
      environment,
    });
    const datosCentral = respuestaCentral?.data ?? respuestaCentral;
    const cbu = datosCentral?.cbu;

    if (!cbu) {
      throw new HttpError(502, 'El Banco Central no devolvió un CBU para la cuenta.');
    }

    return enTransaccionDeBd(async (client) => {
      const tipoCuenta = await client.query(
        'SELECT id FROM tipos_cuenta WHERE nombre = $1 ORDER BY id ASC LIMIT 1',
        [NOMBRE_TIPO_CUENTA]
      );
      if (tipoCuenta.rowCount === 0) {
        throw new HttpError(500, `No se encontró el tipo de cuenta ${NOMBRE_TIPO_CUENTA}.`);
      }

      const insercion = await client.query(
        `INSERT INTO cuentas (
           persona_id, tipo_cuenta_id, numero_cuenta, cbu, alias,
           saldo, moneda, principal, activa, banco_central_registrada
         ) VALUES ($1, $2, $3, $4, $5, 0, $6, FALSE, TRUE, TRUE)
         RETURNING *`,
        [
          personaId,
          tipoCuenta.rows[0].id,
          generarNumeroDeCuentaLocal(personaId),
          cbu,
          alias || datosCentral.alias || null,
          moneda,
        ]
      );

      const cuenta = insercion.rows[0];

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'cuentas',
        entidadId: cuenta.id,
        payloadDespues: cuenta,
        ipAddress,
      });

      return { cuenta, creada: true };
    });
  }

  return { abrirCuenta };
}

const servicioPorDefecto = createCuentasService();

module.exports = {
  abrirCuenta: servicioPorDefecto.abrirCuenta,
  createCuentasService,
  MONEDAS_VALIDAS,
};
