const HttpError = require('../utils/http-error');
const { hasAnyRole } = require('../utils/access-control');

function requireRoles(roles, message = 'No tienes permisos para realizar esta acción.') {
  return (req, _res, next) => {
    if (hasAnyRole(req.currentUser, roles)) {
      return next();
    }

    return next(new HttpError(403, message));
  };
}

module.exports = requireRoles;
