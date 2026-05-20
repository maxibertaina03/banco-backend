const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { extractClerkUserId } = require('./clerk-auth');
const authService = require('../modules/auth-service');

async function requireActiveUser(req, _res, next) {
  const clerkId = extractClerkUserId(req.auth);

  if (!clerkId) {
    return next(new HttpError(401, 'No se pudo identificar al usuario autenticado.'));
  }

  try {
    let result = await pool.query(
      `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
       FROM usuarios u
       JOIN personas p ON p.id = u.persona_id
       WHERE u.clerk_id = $1 AND u.activo = true`,
      [clerkId]
    );

    if (result.rowCount === 0) {
      await authService.getOrCreateUser(clerkId);

      result = await pool.query(
        `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
         FROM usuarios u
         JOIN personas p ON p.id = u.persona_id
         WHERE u.clerk_id = $1 AND u.activo = true`,
        [clerkId]
      );
    }

    if (result.rowCount === 0) {
      return next(new HttpError(403, 'Tu usuario no está registrado o se encuentra inactivo.'));
    }

    const user = result.rows[0];
    const rolesResult = await pool.query(
      `SELECT r.nombre
       FROM personas_roles pr
       JOIN roles r ON r.id = pr.rol_id
       WHERE pr.persona_id = $1`,
      [user.persona_id]
    );

    user.roles = rolesResult.rows.map((row) => row.nombre);
    req.currentUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = requireActiveUser;
