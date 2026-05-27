// Catálogo de tipos de cuenta. Expone los campos necesarios para que el
// frontend pueda mostrar el nombre y validar contra el límite.

function toPublicTipoCuenta(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    limite_transferencia: row.limite_transferencia ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { toPublicTipoCuenta };
