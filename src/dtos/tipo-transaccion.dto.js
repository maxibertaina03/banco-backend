// Catálogo de tipos de transacción.

function aTipoDeTransaccionPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { aTipoDeTransaccionPublico };
