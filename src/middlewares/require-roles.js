const HttpError = require('../utils/http-error');
const { tieneAlgunRol } = require('../utils/access-control');

function requerirRoles(roles, message = 'No tienes permisos para realizar esta acción.') {
  return (req, _res, next) => {
    if (tieneAlgunRol(req.usuarioActual, roles)) {
      return next();
    }

    return next(new HttpError(403, message));
  };
}

module.exports = requerirRoles;
