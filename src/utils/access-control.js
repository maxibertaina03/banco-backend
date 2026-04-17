const INTERNAL_ROLES = new Set(['admin', 'operador', 'auditor', 'tesoreria']);

function hasAnyRole(user, roles) {
  const userRoles = user?.roles || [];
  return roles.some((role) => userRoles.includes(role));
}

function isInternalUser(user) {
  return hasAnyRole(user, [...INTERNAL_ROLES]);
}

module.exports = {
  hasAnyRole,
  isInternalUser,
  INTERNAL_ROLES,
};
