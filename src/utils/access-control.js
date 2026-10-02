// Los roles que operan sobre cualquier persona: mueven plata o gestionan
// clientes.
//
// `auditor` NO está acá a propósito. Su trabajo es mirar, no operar: estando en
// este conjunto podía registrar depósitos y extracciones de efectivo, que es
// justo lo que un perfil de control no debería poder hacer. Su permiso propio
// —leer la auditoría de cualquier usuario— se declara aparte, donde se usa.
const INTERNAL_ROLES = new Set(['admin', 'operador', 'tesoreria', 'gerente']);

/** Quienes pueden leer la trazabilidad de cualquier usuario, sin operar. */
const READ_ONLY_OVERSIGHT_ROLES = new Set(['admin', 'auditor']);

function tieneAlgunRol(user, roles) {
  const userRoles = user?.roles || [];
  return roles.some((role) => userRoles.includes(role));
}

function esUsuarioInterno(user) {
  return tieneAlgunRol(user, [...INTERNAL_ROLES]);
}

/**
 * Si el usuario puede operar sobre los recursos de una persona.
 *
 * Tres casos, y el tercero es el que conviene tener escrito en un solo lugar:
 *  - Rol interno (admin, operador, tesorería, gerente) → sí, sobre cualquiera.
 *  - Cliente → sólo sobre su propia persona.
 *  - **Sin usuario** → sí. Es una llamada interna del backend (un script, un
 *    barrido, un test), no una request HTTP: las rutas bajo `/api` pasan por
 *    `clerkAuth` y `requireActiveUser`, así que ahí `usuarioActual` siempre existe.
 *    Si algún día se monta una ruta fuera de ese pipeline, este es el supuesto
 *    que hay que revisar.
 */
function puedeOperarSobrePersona(usuarioActual, personaId) {
  if (!usuarioActual) return true;
  if (esUsuarioInterno(usuarioActual)) return true;
  return usuarioActual.persona_id === personaId;
}

module.exports = {
  tieneAlgunRol,
  esUsuarioInterno,
  puedeOperarSobrePersona,
  INTERNAL_ROLES,
  READ_ONLY_OVERSIGHT_ROLES,
};
