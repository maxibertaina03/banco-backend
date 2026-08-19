// Mapea filas de la tabla `transacciones` (con o sin JOINs) a la
// representación pública. Los campos *_nombre y *_numero provienen de
// JOINs opcionales y solo se incluyen si la query los devolvió.

const { aNumeroDeApi } = require('../utils/dinero');

function aTransaccionPublica(row) {
  if (!row) return null;
  const result = {
    id: row.id,
    tipo_transaccion_id: row.tipo_transaccion_id,
    cuenta_origen_id: row.cuenta_origen_id,
    cuenta_destino_id: row.cuenta_destino_id,
    cbu_origen: row.cbu_origen ?? null,
    cbu_destino: row.cbu_destino ?? null,
    monto: aNumeroDeApi(row.monto),
    descripcion: row.descripcion ?? null,
    estado: row.estado,
    canal: row.canal ?? null,
    central_transaction_id: row.central_transaction_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.tipo_transaccion_nombre !== undefined) {
    result.tipo_transaccion_nombre = row.tipo_transaccion_nombre;
  }
  if (row.cuenta_origen_numero !== undefined) {
    result.cuenta_origen_numero = row.cuenta_origen_numero;
  }
  if (row.cuenta_destino_numero !== undefined) {
    result.cuenta_destino_numero = row.cuenta_destino_numero;
  }
  return result;
}

module.exports = { aTransaccionPublica };
