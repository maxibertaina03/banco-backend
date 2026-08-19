// Mapea filas de la tabla `usuarios` a la representación pública.
// clerk_id se excluye intencionalmente: es identificador interno del IdP
// (Clerk) y no debe viajar al cliente. El backend lo sigue aceptando como
// input en POST/PUT /usuarios (admin) para asociar usuarios a Clerk.

function aUsuarioPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona_id: row.persona_id,
    activo: row.activo,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { aUsuarioPublico };
