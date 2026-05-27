// Pivote persona↔rol. Solo se expone para gestión interna.

function toPublicPersonaRol(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona_id: row.persona_id,
    rol_id: row.rol_id,
    asignado_at: row.asignado_at,
  };
}

module.exports = { toPublicPersonaRol };
