// Mapea filas de la tabla `cuentas` (con o sin JOIN a tipos_cuenta) a la
// representación pública. Soporta campos opcionales provenientes de JOINs
// sin requerirlos siempre.

function toPublicCuenta(row) {
  if (!row) return null;
  const result = {
    id: row.id,
    persona_id: row.persona_id,
    tipo_cuenta_id: row.tipo_cuenta_id,
    numero_cuenta: row.numero_cuenta,
    cbu: row.cbu,
    alias: row.alias ?? null,
    saldo: row.saldo,
    activa: row.activa,
    banco_central_registrada: row.banco_central_registrada,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.tipo_cuenta_nombre !== undefined) {
    result.tipo_cuenta_nombre = row.tipo_cuenta_nombre;
  }
  if (row.tipo_cuenta_descripcion !== undefined) {
    result.tipo_cuenta_descripcion = row.tipo_cuenta_descripcion;
  }
  return result;
}

module.exports = { toPublicCuenta };
