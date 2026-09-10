const INTERNAL_ROLES = new Set(['admin', 'operador', 'auditor', 'tesoreria']);

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
 *  - Rol interno (admin, operador, auditor, tesorería) → sí, sobre cualquiera.
 *  - Cliente → sólo sobre su propia persona.
 *  - **Sin usuario** → sí. Es una llamada interna del backend (un script, un
 *    barrido, un test), no una request HTTP: las rutas bajo `/api` pasan por
 *    `clerkAuth` y `requireActiveUser`, así que ahí `currentUser` siempre existe.
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
};
