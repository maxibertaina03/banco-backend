const { verifyToken } = require('@clerk/express');
const env = require('../config/env');
const HttpError = require('../utils/http-error');

/**
 * Middleware que verifica el token JWT de Clerk y obtiene el usuario autenticado.
 * Adjunta el usuario de Clerk a req.auth y los datos del usuario de BD a req.user
 */
async function clerkAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return next(new HttpError(401, 'Token no proporcionado.'));
  }

  try {
    const decoded = await verifyToken(token, {
      secretKey: env.clerkSecretKey,
    });

    req.auth = {
      ...decoded,
      userId: extractClerkUserId(decoded),
    };
    next();
  } catch (error) {
    return next(new HttpError(401, 'Token inválido o expirado.'));
  }
}

/**
 * Middleware opcional que adjunta datos del usuario desde la BD si existe un token válido.
 * Si no hay token o no es válido, continúa sin error (req.user será undefined).
 */
async function optionalClerkAuth(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return next();
  }

  try {
    const decoded = await verifyToken(token, {
      secretKey: env.clerkSecretKey,
    });

    req.auth = {
      ...decoded,
      userId: extractClerkUserId(decoded),
    };
    next();
  } catch (error) {
    // No hay error si el token es inválido, simplemente continuamos sin autenticación
    next();
  }
}

/**
 * Extrae el token JWT del header Authorization (Bearer token)
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

function extractClerkUserId(auth) {
  return auth?.sub || auth?.userId || auth?.clerk_id || null;
}

module.exports = {
  clerkAuth,
  optionalClerkAuth,
  extractToken,
  extractClerkUserId,
};
