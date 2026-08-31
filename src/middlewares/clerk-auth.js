const { verifyToken } = require('@clerk/backend');
const env = require('../config/env');
const HttpError = require('../utils/http-error');

async function clerkAuth(req, _res, next) {
  const authorization = req.get('authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    return next(new HttpError(401, 'Se requiere autenticación.'));
  }

  try {
    const claims = await verifyToken(token, { secretKey: env.clerkSecretKey });
    req.clerkUserId = claims.sub;
    return next();
  } catch (_error) {
    return next(new HttpError(401, 'La sesión de Clerk no es válida.'));
  }
}

module.exports = clerkAuth;
