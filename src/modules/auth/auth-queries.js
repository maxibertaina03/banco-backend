// Consultas SQL de autenticación.
//
// Cada función recibe un `executor` (el `pool` para queries sueltas, o el
// `client` de una transacción para queries dentro de BEGIN/COMMIT). Así el
// control transaccional queda en el service y estas funciones solo encapsulan
// el SQL — el texto se mantiene idéntico al original para no romper los tests
// que asertan sobre las queries.

/** Usuario activo + datos básicos de persona, por clerk_id. */
function selectActiveUserWithPersona(executor, clerkId) {
  return executor.query(
    `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
       FROM usuarios u
       JOIN personas p ON u.persona_id = p.id
       WHERE u.clerk_id = $1 AND u.activo = true`,
    [clerkId]
  );
}

/** Usuario + persona por clerk_id, SIN filtro de activo (para reactivar). */
function selectUserWithPersonaAnyState(executor, clerkId) {
  return executor.query(
    `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
         FROM usuarios u
         JOIN personas p ON p.id = u.persona_id
         WHERE u.clerk_id = $1`,
    [clerkId]
  );
}

/** Persona por id. */
function selectPersonaById(executor, personaId) {
  return executor.query('SELECT * FROM personas WHERE id = $1', [personaId]);
}

/** Usuario por persona_id. */
function selectUsuarioByPersonaId(executor, personaId) {
  return executor.query('SELECT * FROM usuarios WHERE persona_id = $1', [personaId]);
}

/** Usuario por clerk_id (cualquier estado). */
function selectUsuarioByClerkId(executor, clerkId) {
  return executor.query('SELECT * FROM usuarios WHERE clerk_id = $1', [clerkId]);
}

/** id + persona_id de un usuario por clerk_id (usado en el webhook). */
function selectUsuarioIdAndPersona(executor, clerkId) {
  return executor.query(
    `SELECT u.id, u.persona_id
         FROM usuarios u
         WHERE u.clerk_id = $1
         LIMIT 1`,
    [clerkId]
  );
}

/** Reasigna clerk_id y reactiva el usuario de una persona existente. */
function reassignClerkIdToPersona(executor, clerkId, personaId) {
  return executor.query(
    `UPDATE usuarios
         SET clerk_id = $1,
             activo = true
         WHERE persona_id = $2
         RETURNING *`,
    [clerkId, personaId]
  );
}

/** Inserta un usuario nuevo enlazado a una persona. */
function insertUsuario(executor, personaId, clerkId) {
  return executor.query(
    `INSERT INTO usuarios (persona_id, clerk_id, activo)
       VALUES ($1, $2, true)
       RETURNING *`,
    [personaId, clerkId]
  );
}

/** Perfil completo (usuario + persona) por clerk_id, solo activos. */
function selectUserProfile(executor, clerkId) {
  return executor.query(
    `SELECT
         u.id,
         u.persona_id,
         u.activo,
         u.created_at as usuario_created_at,
         p.nombre,
         p.apellido,
         p.dni,
         p.email,
         p.telefono,
         p.fecha_nacimiento,
         p.perfil_completo,
         p.created_at as persona_created_at
       FROM usuarios u
       JOIN personas p ON u.persona_id = p.id
       WHERE u.clerk_id = $1 AND u.activo = true`,
    [clerkId]
  );
}

/** Roles de una persona. */
function selectRolesByPersona(executor, personaId) {
  return executor.query(
    `SELECT r.* FROM personas_roles pr
       JOIN roles r ON r.id = pr.rol_id
       WHERE pr.persona_id = $1`,
    [personaId]
  );
}

/** Desactiva un usuario y lo devuelve (logout suave). */
function deactivateUserReturning(executor, clerkId) {
  return executor.query(
    'UPDATE usuarios SET activo = false WHERE clerk_id = $1 RETURNING *',
    [clerkId]
  );
}

/** Desactiva un usuario sin devolverlo (webhook de Clerk). */
function deactivateUser(executor, clerkId) {
  return executor.query(
    `UPDATE usuarios
       SET activo = false
       WHERE clerk_id = $1`,
    [clerkId]
  );
}

/** Reactiva un usuario por id. */
function reactivateUsuarioById(executor, id) {
  return executor.query(
    `UPDATE usuarios
           SET activo = true
           WHERE id = $1`,
    [id]
  );
}

/** Reactiva un usuario por clerk_id y lo devuelve. */
function reactivateUsuarioByClerkId(executor, clerkId) {
  return executor.query(
    `UPDATE usuarios
           SET activo = true
           WHERE clerk_id = $1
           RETURNING *`,
    [clerkId]
  );
}

/**
 * Mergea campos de la persona solo si el perfil aún NO está completo
 * (no pisa datos que el usuario ya cargó). Usado en el webhook al reactivar.
 */
function mergePersonaIfIncomplete(executor, { firstName, lastName, email, phone, personaId }) {
  return executor.query(
    `UPDATE personas
           SET nombre = CASE
                 WHEN perfil_completo = false THEN COALESCE($1, nombre)
                 ELSE nombre
               END,
               apellido = CASE
                 WHEN perfil_completo = false THEN COALESCE($2, apellido)
                 ELSE apellido
               END,
               email = CASE
                 WHEN perfil_completo = false THEN COALESCE($3, email)
                 ELSE email
               END,
               telefono = CASE
                 WHEN perfil_completo = false THEN COALESCE($4, telefono)
                 ELSE telefono
               END
           WHERE id = $5`,
    [firstName, lastName, email, phone, personaId]
  );
}

/** id de persona por email (con LIMIT 1). */
function selectPersonaIdByEmail(executor, email) {
  return executor.query('SELECT id FROM personas WHERE email = $1 LIMIT 1', [email]);
}

/** Persona completa por email (sin LIMIT). */
function selectPersonaByEmail(executor, email) {
  return executor.query('SELECT * FROM personas WHERE email = $1', [email]);
}

/** Rellena campos vacíos de una persona existente (no pisa lo que ya hay). */
function fillEmptyPersonaFields(executor, { firstName, lastName, phone, personaId }) {
  return executor.query(
    `UPDATE personas
           SET nombre = COALESCE(NULLIF(nombre, ''), $1),
               apellido = COALESCE(NULLIF(apellido, ''), $2),
               telefono = COALESCE(telefono, $3)
           WHERE id = $4`,
    [firstName, lastName, phone, personaId]
  );
}

/** Crea una persona incompleta y devuelve solo el id. */
function insertPersonaReturningId(executor, { firstName, lastName, email, phone }) {
  return executor.query(
    `INSERT INTO personas (nombre, apellido, email, telefono, perfil_completo)
           VALUES ($1, $2, $3, $4, false)
           RETURNING id`,
    [firstName, lastName, email, phone]
  );
}

/** Crea una persona incompleta y devuelve la fila completa. */
function insertPersonaReturningAll(executor, { firstName, lastName, email, phone }) {
  return executor.query(
    `INSERT INTO personas (nombre, apellido, email, telefono, perfil_completo)
           VALUES ($1, $2, $3, $4, false)
           RETURNING *`,
    [firstName, lastName, email, phone]
  );
}

/** Upsert de usuario por clerk_id (reactiva si ya existía). */
function upsertUsuarioByClerkId(executor, personaId, clerkId) {
  return executor.query(
    `INSERT INTO usuarios (persona_id, clerk_id, activo)
         VALUES ($1, $2, true)
         ON CONFLICT (clerk_id) DO UPDATE
         SET activo = true`,
    [personaId, clerkId]
  );
}

/** Usuario + persona por id de usuario. */
function selectFullUserById(executor, userId) {
  return executor.query(
    `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
         FROM usuarios u
         JOIN personas p ON p.id = u.persona_id
         WHERE u.id = $1`,
    [userId]
  );
}

/** Rol por nombre. */
function selectRoleByName(executor, nombre) {
  return executor.query('SELECT id FROM roles WHERE nombre = $1 LIMIT 1', [nombre]);
}

/** Asigna un rol a una persona (idempotente). */
function insertPersonaRole(executor, personaId, rolId) {
  return executor.query(
    `INSERT INTO personas_roles (persona_id, rol_id)
       VALUES ($1, $2)
       ON CONFLICT (persona_id, rol_id) DO NOTHING`,
    [personaId, rolId]
  );
}

/**
 * Actualización parcial del perfil. Recibe la cláusula SET ya armada (con sus
 * placeholders) y el arreglo de valores completo (campos + clerkId al final).
 */
function updatePersonaPartial(executor, setClause, clerkIdParam, values) {
  return executor.query(
    `UPDATE personas p
       SET ${setClause}
       FROM usuarios u
       WHERE u.persona_id = p.id
         AND u.clerk_id = ${clerkIdParam}
         AND u.activo = true
       RETURNING
         u.id,
         u.persona_id,
         u.activo,
         p.nombre,
         p.apellido,
         p.dni,
         p.email,
         p.telefono,
         p.fecha_nacimiento,
         p.perfil_completo`,
    values
  );
}

/** Marca el perfil como completo con todos los datos obligatorios. */
function completeProfile(executor, payload, clerkId) {
  return executor.query(
    `UPDATE personas p
       SET nombre = $1,
           apellido = $2,
           dni = $3,
           email = $4,
           telefono = $5,
           fecha_nacimiento = $6,
           perfil_completo = true
       FROM usuarios u
       WHERE u.persona_id = p.id
         AND u.clerk_id = $7
         AND u.activo = true
       RETURNING
         u.id,
         u.persona_id,
         u.activo,
         p.nombre,
         p.apellido,
         p.dni,
         p.email,
         p.telefono,
         p.fecha_nacimiento,
         p.perfil_completo`,
    [
      payload.nombre,
      payload.apellido,
      payload.dni,
      payload.email,
      payload.telefono,
      payload.fecha_nacimiento,
      clerkId,
    ]
  );
}

module.exports = {
  selectActiveUserWithPersona,
  selectUserWithPersonaAnyState,
  selectPersonaById,
  selectUsuarioByPersonaId,
  selectUsuarioByClerkId,
  selectUsuarioIdAndPersona,
  reassignClerkIdToPersona,
  insertUsuario,
  selectUserProfile,
  selectRolesByPersona,
  deactivateUserReturning,
  deactivateUser,
  reactivateUsuarioById,
  reactivateUsuarioByClerkId,
  mergePersonaIfIncomplete,
  selectPersonaIdByEmail,
  selectPersonaByEmail,
  fillEmptyPersonaFields,
  insertPersonaReturningId,
  insertPersonaReturningAll,
  upsertUsuarioByClerkId,
  selectFullUserById,
  selectRoleByName,
  insertPersonaRole,
  updatePersonaPartial,
  completeProfile,
};
