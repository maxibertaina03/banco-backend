const HttpError = require('../utils/http-error');
const { isInternalUser } = require('../utils/access-control');

function requireCompleteProfile(req, _res, next) {
  if (isInternalUser(req.currentUser) || req.currentUser?.perfil_completo === true) {
    return next();
  }

  return next(
    new HttpError(403, 'Debes completar tu perfil antes de usar esta funcionalidad.', {
      code: 'PROFILE_INCOMPLETE',
    })
  );
}

module.exports = requireCompleteProfile;
