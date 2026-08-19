const HttpError = require('../utils/http-error');
const { esUsuarioInterno } = require('../utils/access-control');

function requerirPerfilCompleto(req, _res, next) {
  if (esUsuarioInterno(req.usuarioActual) || req.usuarioActual?.perfil_completo === true) {
    return next();
  }

  return next(
    new HttpError(403, 'Debes completar tu perfil antes de usar esta funcionalidad.', {
      code: 'PROFILE_INCOMPLETE',
    })
  );
}

module.exports = requerirPerfilCompleto;
