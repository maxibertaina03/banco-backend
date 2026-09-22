// Bonificaciones que el banco regala.
//
// Por ahora hay una: la "órbita secreta". Quien toca el isotipo que orbita en
// el login o el registro se gana US$ 5 de bienvenida en su caja en dólares, y
// si no tiene esa caja, se la abre. Da igual si es un cliente nuevo o uno de
// antes: la condición es no haberla cobrado nunca.
//
// Es plata gratis, así que el "una vez por persona" no puede depender del
// navegador (se saltea llamando a la API directo) ni de un chequeo en el
// código (dos pedidos a la vez lo pasan los dos). Lo garantiza la restricción
// única de la tabla `bonificaciones`, y el registro se inserta ANTES de
// acreditar: si choca, la acreditación ni ocurre.

const realPool = require('../db/pool');
const { abrirCuenta: realAbrirCuenta } = require('./cuentas-service');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const movimientos = require('./movimientos');

const BIENVENIDA = {
  tipo: 'bienvenida',
  monto: Dinero.desde(5),
  moneda: 'USD',
  descripcion: 'Bonificación de bienvenida: encontraste la órbita secreta',
};

const YA_COBRADA = 'Ya recibiste tu bonificación de bienvenida.';

function createBonificacionesService({
  pool = realPool,
  abrirCuenta = realAbrirCuenta,
  escribirLogDeAuditoria = realEscribirLog,
} = {}) {
  async function otorgarBienvenida({ usuarioActual, ipAddress = null }) {
    const personaId = usuarioActual?.persona_id;
    if (!personaId) {
      throw new HttpError(403, 'No se pudo identificar tu perfil bancario.');
    }

    // Atajo, no garantía: evita abrir cuentas o molestar al Central por un
    // pedido repetido. La garantía es la restricción única de más abajo.
    const previa = await pool.query(
      'SELECT 1 FROM bonificaciones WHERE persona_id = $1 AND tipo = $2',
      [personaId, BIENVENIDA.tipo]
    );
    if (previa.rowCount > 0) {
      throw new HttpError(409, YA_COBRADA);
    }

    // Fuera de la transacción: habla con el Banco Central. Si ya tiene caja en
    // dólares, la devuelve sin crear otra. Si no puede abrirla (situación
    // crediticia, Central caído), tira y no se registra nada: puede reintentar.
    const { cuenta, creada } = await abrirCuenta({
      personaId,
      moneda: BIENVENIDA.moneda,
      usuarioActual,
      ipAddress,
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const registro = await client.query(
        `INSERT INTO bonificaciones (persona_id, tipo, monto, moneda)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [personaId, BIENVENIDA.tipo, BIENVENIDA.monto.aString(), BIENVENIDA.moneda]
      );

      const transaccion = await movimientos.acreditar(client, {
        cuentaId: cuenta.id,
        cbu: cuenta.cbu,
        monto: BIENVENIDA.monto.aString(),
        tipo: 'bonificacion',
        canal: 'bonificacion',
        descripcion: BIENVENIDA.descripcion,
      });

      await client.query('UPDATE bonificaciones SET transaccion_id = $1 WHERE id = $2', [
        transaccion.id,
        registro.rows[0].id,
      ]);

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'bonificaciones',
        entidadId: registro.rows[0].id,
        payloadDespues: { tipo: BIENVENIDA.tipo, monto: BIENVENIDA.monto.aString(), moneda: BIENVENIDA.moneda },
        ipAddress,
      });

      await client.query('COMMIT');

      return {
        monto: BIENVENIDA.monto.aNumero(),
        moneda: BIENVENIDA.moneda,
        cuenta_abierta: creada,
        cuenta: { id: cuenta.id, cbu: cuenta.cbu, numero_cuenta: cuenta.numero_cuenta },
        transaccion_id: transaccion.id,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      // 23505: otro pedido simultáneo la registró primero. No es un error del
      // sistema: ya la cobró.
      if (error?.code === '23505') {
        throw new HttpError(409, YA_COBRADA);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return { otorgarBienvenida };
}

const servicioPorDefecto = createBonificacionesService();

module.exports = { ...servicioPorDefecto, createBonificacionesService, BIENVENIDA };
