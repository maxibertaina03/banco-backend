const pool = require('../db/pool');
const HttpError = require('../utils/http-error');

/**
 * Obtiene o crea un usuario en la base de datos basado en el clerk_id.
 * Si el usuario no existe, genera un error ya que necesita persona_id.
 */
async function getOrCreateUser(clerkId) {
  const result = await pool.query(
    `SELECT u.*, p.nombre, p.apellido, p.email
     FROM usuarios u
     JOIN personas p ON u.persona_id = p.id
     WHERE u.clerk_id = $1 AND u.activo = true`,
    [clerkId]
  );

  if (result.rowCount > 0) {
    return result.rows[0];
  }

  throw new HttpError(404, 'Usuario no encontrado o inactivo. Debes registrarte primero con tu persona.');
}

/**
 * Crea un nuevo usuario enlazando un persona existente con Clerk.
 * Se da por supuesto que ya existe una persona en la BD.
 */
async function createUserWithClerk(personaId, clerkId) {
  // Verificar que la persona existe
  const personaResult = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
  if (personaResult.rowCount === 0) {
    throw new HttpError(404, `No existe la persona con id ${personaId}.`);
  }

  const existingByPersona = await pool.query('SELECT * FROM usuarios WHERE persona_id = $1', [personaId]);

  // Verificar que no exista ya un usuario con ese clerk_id
  const existingUser = await pool.query('SELECT * FROM usuarios WHERE clerk_id = $1', [clerkId]);
  if (existingUser.rowCount > 0 && existingUser.rows[0].persona_id !== personaId) {
    throw new HttpError(400, 'Ya existe un usuario con ese clerk_id.');
  }

  if (existingByPersona.rowCount > 0) {
    const result = await pool.query(
      `UPDATE usuarios
       SET clerk_id = $1,
           activo = true
       WHERE persona_id = $2
       RETURNING *`,
      [clerkId, personaId]
    );

    return result.rows[0];
  }

  // Crear nuevo usuario
  const result = await pool.query(
    `INSERT INTO usuarios (persona_id, clerk_id, activo)
     VALUES ($1, $2, true)
     RETURNING *`,
    [personaId, clerkId]
  );

  return result.rows[0];
}

/**
 * Obtiene el perfil completo del usuario autenticado.
 */
async function getUserProfile(clerkId) {
  const result = await pool.query(
    `SELECT 
       u.id,
       u.persona_id,
       u.clerk_id,
       u.activo,
       u.created_at as usuario_created_at,
       p.nombre,
       p.apellido,
       p.dni,
       p.email,
       p.telefono,
       p.fecha_nacimiento,
       p.created_at as persona_created_at
     FROM usuarios u
     JOIN personas p ON u.persona_id = p.id
     WHERE u.clerk_id = $1 AND u.activo = true`,
    [clerkId]
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'Usuario no encontrado o inactivo.');
  }

  const user = result.rows[0];

  // Obtener roles del usuario
  const rolesResult = await pool.query(
    `SELECT r.* FROM personas_roles pr
     JOIN roles r ON r.id = pr.rol_id
     WHERE pr.persona_id = $1`,
    [user.persona_id]
  );

  user.roles = rolesResult.rows;
  return user;
}

/**
 * Desactiva un usuario (logout "suave").
 */
async function deactivateUser(clerkId) {
  const result = await pool.query(
    'UPDATE usuarios SET activo = false WHERE clerk_id = $1 RETURNING *',
    [clerkId]
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'Usuario no encontrado.');
  }

  return result.rows[0];
}

module.exports = {
  getOrCreateUser,
  createUserWithClerk,
  getUserProfile,
  deactivateUser,
};
