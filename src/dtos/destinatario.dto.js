// Mapea filas de la tabla `destinatarios` a la representación pública.

function aDestinatarioPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona_id: row.persona_id,
    alias: row.alias ?? null,
    cbu_externo: row.cbu_externo,
    banco_externo: row.banco_externo ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { aDestinatarioPublico };
