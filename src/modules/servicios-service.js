// Pago de facturas de servicios.
//
// El orden de las operaciones es lo único delicado acá, y es el que evita los
// dos desastres posibles:
//
//   1. Se lee la factura del proveedor y se toma SU monto. El cliente manda el
//      id de la factura, nunca el importe: si lo mandara, podría pagar una
//      factura de 45.000 enviando 1.
//   2. Se bloquea la cuenta (FOR UPDATE) y se verifica el saldo.
//   3. Se le pide el cobro al proveedor.
//   4. Recién si el proveedor confirmó, se debita y se hace commit.
//
// Si el paso 3 falla, rollback: no se debita nada. Al revés (debitar primero)
// el cliente pagaría por una factura que el proveedor nunca dio por cobrada.

const realPool = require('../db/pool');
const { createProveedoresClient } = require('./proveedores/proveedores-client');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero, aNumeroDeApi } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const { puedeOperarSobrePersona } = require('../utils/access-control');
const movimientos = require('./movimientos');

/**
 * Traduce una factura del proveedor a la forma del banco.
 *
 * El proveedor la publica con `importe`; hacia el cliente el campo es `monto`.
 * Según el glosario, `importe` se reserva para lo que viaja hacia el Banco
 * Central, así que la traducción se hace acá y no se filtra al resto.
 */
function aFacturaPublica(factura) {
  return {
    id: factura.id,
    empresa_id: factura.empresa_id,
    numero_cliente: factura.numero_cliente,
    periodo: factura.periodo,
    monto: aNumeroDeApi(factura.importe),
    vencimiento: factura.vencimiento,
    estado: factura.estado,
  };
}

function createServiciosService({
  pool = realPool,
  proveedores = createProveedoresClient(),
  escribirLogDeAuditoria = realEscribirLog,
} = {}) {
  async function listarEmpresas(rubro = null) {
    return proveedores.listarEmpresas(rubro);
  }

  /** Un cliente al día devuelve la lista vacía, no un 404: existe, sólo que no debe nada. */
  async function consultarDeuda({ empresaId, numeroCliente }) {
    const [empresas, deuda] = await Promise.all([
      proveedores.listarEmpresas(),
      proveedores.consultarDeuda(empresaId, numeroCliente),
    ]);

    const empresa = empresas.find((e) => e.id === empresaId) || null;
    const facturas = (deuda.facturas || []).map(aFacturaPublica);

    return {
      empresa,
      numero_cliente: deuda.numero_cliente ?? String(numeroCliente),
      total_adeudado: aNumeroDeApi(deuda.total_adeudado ?? 0),
      facturas,
    };
  }

  async function pagarFactura({
    cuenta_id: cuentaId,
    empresa_id: empresaId,
    numero_cliente: numeroCliente,
    factura_id: facturaId,
    usuarioActual,
    ipAddress,
    idempotencyKey = null,
  }) {
    // 1. La factura y su monto salen del proveedor, antes de tocar la cuenta.
    const deuda = await proveedores.consultarDeuda(empresaId, numeroCliente);
    const factura = (deuda.facturas || []).find((f) => f.id === facturaId);

    if (!factura) {
      // El proveedor sólo lista las impagas, así que no se puede distinguir una
      // factura inexistente de uno que ya pagó: el mensaje cubre los dos casos.
      throw new HttpError(404, 'La factura no existe o ya no figura como impaga.');
    }

    const montoFactura = Dinero.desde(factura.importe);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 2. Cuenta bloqueada: dos pagos simultáneos no pueden dejar el saldo en negativo.
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
        throw new HttpError(400, 'Los servicios se pagan desde una cuenta en pesos.');
      }
      if (montoFactura.mayorQue(cuenta.saldo)) {
        throw new HttpError(422, 'Saldo insuficiente para pagar la factura.');
      }

      // 3. El cobro al proveedor. Si tira, el catch hace ROLLBACK y no se debita.
      const cobro = await proveedores.pagarFactura(
        empresaId,
        { facturaId, importe: montoFactura.aNumero() },
        idempotencyKey
      );

      // 4. Confirmado: recién ahora se mueve la plata.
      const transaccion = await movimientos.debitar(client, {
        cuentaId: cuenta.id,
        cbu: cuenta.cbu,
        monto: montoFactura.aString(),
        tipo: 'pago',
        canal: 'pago_servicio',
        descripcion: `Pago ${deuda.empresa?.nombre || empresaId} ${factura.periodo}`,
      });

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'transacciones',
        entidadId: transaccion.id,
        payloadDespues: { ...transaccion, comprobante: cobro.comprobante },
        ipAddress,
      });

      await client.query('COMMIT');

      return {
        transaccion,
        factura: aFacturaPublica(cobro.factura || { ...factura, estado: 'pagada' }),
        comprobante: cobro.comprobante,
        fecha_pago: cobro.fecha_pago,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { listarEmpresas, consultarDeuda, pagarFactura };
}

const servicioPorDefecto = createServiciosService();

module.exports = { ...servicioPorDefecto, createServiciosService, aFacturaPublica };
