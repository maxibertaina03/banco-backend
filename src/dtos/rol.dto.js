// Mapea filas de `roles` (con o sin metadatos de personas_roles) a la
// representación pública usada por /personas/:id/roles y /personas/:id/full.

function aRolPublico(row) {
  if (!row) return null;
  const result = {
    id: row.id,
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
  };
  if (row.persona_rol_id !== undefined) {
    result.persona_rol_id = row.persona_rol_id;
  }
  if (row.asignado_at !== undefined) {
    result.asignado_at = row.asignado_at;
  }
  return result;
}

module.exports = { aRolPublico };
