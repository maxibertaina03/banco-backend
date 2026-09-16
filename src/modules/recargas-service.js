// Recarga de celulares prepagos.
//
// Mismo orden que el pago de servicios: bloquear la cuenta y verificar saldo,
// pedirle la recarga al proveedor, y sólo si confirmó, debitar. Si el proveedor
// rechaza (los números terminados en 0000, a propósito) o no responde, rollback
// y no se debita nada.

const realPool = require('../db/pool');
const { createProveedoresClient } = require('./proveedores/proveedores-client');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const { puedeOperarSobrePersona } = require('../utils/access-control');
const movimientos = require('./movimientos');

function createRecargasService({
  pool = realPool,
  proveedores = createProveedoresClient(),
  escribirLogDeAuditoria = realEscribirLog,
} = {}) {
  async function listarOperadoras() {
    return proveedores.listarOperadoras();
  }

  async function recargar({
    cuenta_id: cuentaId,
    operadora_id: operadoraId,
    numero,
    monto,
    usuarioActual,
    ipAddress,
    idempotencyKey = null,
  }) {
    // El monto se valida contra el catálogo ANTES de tocar la cuenta o al
    // proveedor: es una regla conocida y no hace falta gastar una llamada para
    // que nos la rechacen.
    const operadoras = await proveedores.listarOperadoras();
    const operadora = operadoras.find((o) => o.id === operadoraId);

    if (!operadora) {
      throw new HttpError(404, `No existe la operadora "${operadoraId}".`);
    }
    if (!operadora.montos_disponibles.includes(monto)) {
      throw new HttpError(
        400,
        `${operadora.nombre} no acepta ese monto. Disponibles: ${operadora.montos_disponibles.join(', ')}.`
      );
    }

    const montoRecarga = Dinero.desde(monto);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const c = await client.query(
        'SELECT id, persona_id, cbu, moneda, saldo, activa FROM cuentas WHERE id = $1 LIMIT 1 FOR UPDATE',
        [cuentaId]
      );
      if (c.rowCount === 0) {
        throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
      }
      const cuenta = c.rows[0];

      if (!puedeOperarSobrePersona(usuarioActual, cuenta.persona_id)) {
        throw new HttpError(403, 'No puedes operar sobre una cuenta que no te pertenece.');
      }
      if (!cuenta.activa) {
        throw new HttpError(400, 'La cuenta no está activa.');
      }
      if ((cuenta.moneda || 'ARS') !== 'ARS') {
        throw new HttpError(400, 'Las recargas se pagan desde una cuenta en pesos.');
      }
      if (montoRecarga.mayorQue(cuenta.saldo)) {
        throw new HttpError(422, 'Saldo insuficiente para la recarga.');
      }

      const recarga = await proveedores.recargar(operadoraId, { numero, monto: montoRecarga.aNumero() }, idempotencyKey);

      const transaccion = await movimientos.debitar(client, {
        cuentaId: cuenta.id,
        cbu: cuenta.cbu,
        monto: montoRecarga.aString(),
        tipo: 'pago',
        canal: 'recarga_celular',
        descripcion: `Recarga ${operadora.nombre} ${numero}`,
      });

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'transacciones',
        entidadId: transaccion.id,
        payloadDespues: { ...transaccion, recarga_id: recarga.id },
        ipAddress,
      });

      await client.query('COMMIT');

      return {
        transaccion,
        recarga: {
          id: recarga.id,
          operadora: recarga.operadora || operadora.nombre,
          numero: recarga.numero,
          monto: Dinero.desde(recarga.monto ?? monto).aNumero(),
          estado: recarga.estado || 'acreditada',
          fecha: recarga.fecha,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { listarOperadoras, recargar };
}

const servicioPorDefecto = createRecargasService();

module.exports = { ...servicioPorDefecto, createRecargasService };
