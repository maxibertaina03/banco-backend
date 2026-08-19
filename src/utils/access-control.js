const INTERNAL_ROLES = new Set(['admin', 'operador', 'auditor', 'tesoreria']);

function tieneAlgunRol(user, roles) {
  const userRoles = user?.roles || [];
  return roles.some((role) => userRoles.includes(role));
}

function esUsuarioInterno(user) {
  return tieneAlgunRol(user, [...INTERNAL_ROLES]);
}

module.exports = {
  tieneAlgunRol,
  esUsuarioInterno,
  INTERNAL_ROLES,
};
