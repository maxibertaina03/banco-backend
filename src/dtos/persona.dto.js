// Mapea filas de la tabla `personas` a la representación pública del API.
// Centraliza qué campos salen al cliente: agregar columnas a la tabla no las
// expone automáticamente.

function aPersonaPublica(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    apellido: row.apellido,
    email: row.email,
    dni: row.dni ?? null,
    telefono: row.telefono ?? null,
    fecha_nacimiento: row.fecha_nacimiento ?? null,
    perfil_completo: row.perfil_completo ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Versión reducida para listados/búsquedas (sin PII innecesaria).
function aOpcionDePersona(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    apellido: row.apellido,
    email: row.email,
    dni: row.dni ?? null,
    telefono: row.telefono ?? null,
  };
}

module.exports = { aPersonaPublica, aOpcionDePersona };
