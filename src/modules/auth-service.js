// Service de autenticación con Clerk + sincronización de usuarios.
//
// Patrón: factory `createAuthService({ pool, clerkApi })` para tests con
// dependency injection. El `module.exports` por defecto usa la instancia real
// (igual que transacciones-service), así que los consumidores (auth-router,
// clerk-webhook-router) no necesitan cambios.

const axios = require('axios');
const HttpError = require('../utils/http-error');
const env = require('../config/env');
const realPool = require('../db/pool');

const realClerkApi = axios.create({
  baseURL: 'https://api.clerk.com/v1',
  headers: {
    Authorization: `Bearer ${env.clerkSecretKey}`,
    'Content-Type': 'application/json',
  },
});

function createAuthService({ pool = realPool, clerkApi = realClerkApi } = {}) {
  // ── Helpers internos puros ────────────────────────────────────────────────

  function getPrimaryEmail(clerkUser) {
    const addresses = clerkUser.email_addresses || [];
    const primaryId = clerkUser.primary_email_address_id;
    const primary =
      addresses.find((address) => address.id === primaryId) ||
      addresses.find((address) => address.email_address);
    return primary?.email_address?.trim().toLowerCase() || null;
  }

  function normalizeOptionalText(value) {
    const trimmed = value?.trim();
    return trimmed || null;
  }

  function normalizePhone(phoneNumbers = []) {
    const phone = phoneNumbers.find((item) => item.phone_number)?.phone_number || null;
    return phone;
  }

  function mapProvisionError(error) {
    if (error instanceof HttpError) return error;
    if (error.code === '23505') {
      return new HttpError(409, 'No se pudo aprovisionar automáticamente el usuario por un conflicto de datos.');
    }
    return error;
  }

  async function ensureClienteRole(client, personaId) {
    const roleResult = await client.query('SELECT id FROM roles WHERE nombre = $1 LIMIT 1', ['cliente']);
    if (roleResult.rowCount === 0) return;
    await client.query(
      `INSERT INTO personas_roles (persona_id, rol_id)
       VALUES ($1, $2)
       ON CONFLICT (persona_id, rol_id) DO NOTHING`,
      [personaId, roleResult.rows[0].id]
    );
  }

  async function fetchClerkUser(clerkId) {
    try {
      const response = await clerkApi.get(`/users/${clerkId}`);
      return response.data;
    } catch (_error) {
      throw new HttpError(502, 'No se pudieron obtener los datos del usuario desde Clerk.');
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  /**
   * Obtiene o crea un usuario en la BD basado en clerk_id. Si no existe
   * localmente, lo aprovisiona desde Clerk.
   */
  async function getOrCreateUser(clerkId) {
    const result = await pool.query(
      `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
       FROM usuarios u
       JOIN personas p ON u.persona_id = p.id
       WHERE u.clerk_id = $1 AND u.activo = true`,
      [clerkId]
    );

    if (result.rowCount > 0) {
      return result.rows[0];
    }
    return provisionUserFromClerk(clerkId);
  }

  /**
   * Crea un nuevo usuario enlazando una persona existente con Clerk.
   * Se da por supuesto que la persona ya existe.
   */
  async function createUserWithClerk(personaId, clerkId) {
    const personaResult = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
    if (personaResult.rowCount === 0) {
      throw new HttpError(404, `No existe la persona con id ${personaId}.`);
    }

    const existingByPersona = await pool.query('SELECT * FROM usuarios WHERE persona_id = $1', [personaId]);

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

    const result = await pool.query(
      `INSERT INTO usuarios (persona_id, clerk_id, activo)
       VALUES ($1, $2, true)
       RETURNING *`,
      [personaId, clerkId]
    );
    return result.rows[0];
  }

  /**
   * Obtiene el perfil completo del usuario autenticado. Si no se encuentra,
   * fuerza aprovisionamiento y reintenta una sola vez.
   */
  async function getUserProfile(clerkId) {
    const result = await pool.query(
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

    if (result.rowCount === 0) {
      await getOrCreateUser(clerkId);
      return getUserProfile(clerkId);
    }

    const user = result.rows[0];

    const rolesResult = await pool.query(
      `SELECT r.* FROM personas_roles pr
       JOIN roles r ON r.id = pr.rol_id
       WHERE pr.persona_id = $1`,
      [user.persona_id]
    );

    user.roles = rolesResult.rows;
    return user;
  }

  /** Desactiva un usuario (logout "suave"). */
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

  /**
   * Sincroniza un usuario que llega desde un webhook de Clerk. Si ya existe,
   * reactiva y actualiza solo los campos que el usuario aún no completó. Si
   * es nuevo, crea persona (o usa la existente si matchea el email) y user.
   */
  async function syncClerkUserFromWebhook(clerkUser) {
    const clerkId = clerkUser?.id;
    if (!clerkId) {
      throw new HttpError(400, 'El evento de Clerk no incluye un user id válido.');
    }

    const email = getPrimaryEmail(clerkUser);
    const firstName = normalizeOptionalText(clerkUser.first_name);
    const lastName = normalizeOptionalText(clerkUser.last_name);
    const phone = normalizePhone(clerkUser.phone_numbers);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingUser = await client.query(
        `SELECT u.id, u.persona_id
         FROM usuarios u
         WHERE u.clerk_id = $1
         LIMIT 1`,
        [clerkId]
      );

      if (existingUser.rowCount > 0) {
        const personaId = existingUser.rows[0].persona_id;

        await client.query(
          `UPDATE usuarios
           SET activo = true
           WHERE id = $1`,
          [existingUser.rows[0].id]
        );

        await client.query(
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

        await client.query('COMMIT');
        return;
      }

      let personaId;
      const existingPersona = email
        ? await client.query('SELECT id FROM personas WHERE email = $1 LIMIT 1', [email])
        : { rowCount: 0 };

      if (existingPersona.rowCount > 0) {
        personaId = existingPersona.rows[0].id;
        await client.query(
          `UPDATE personas
           SET nombre = COALESCE(NULLIF(nombre, ''), $1),
               apellido = COALESCE(NULLIF(apellido, ''), $2),
               telefono = COALESCE(telefono, $3)
           WHERE id = $4`,
          [firstName, lastName, phone, personaId]
        );
      } else {
        const createdPersona = await client.query(
          `INSERT INTO personas (nombre, apellido, email, telefono, perfil_completo)
           VALUES ($1, $2, $3, $4, false)
           RETURNING id`,
          [firstName, lastName, email, phone]
        );
        personaId = createdPersona.rows[0].id;
      }

      await client.query(
        `INSERT INTO usuarios (persona_id, clerk_id, activo)
         VALUES ($1, $2, true)
         ON CONFLICT (clerk_id) DO UPDATE
         SET activo = true`,
        [personaId, clerkId]
      );

      await ensureClienteRole(client, personaId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapProvisionError(error);
    } finally {
      client.release();
    }
  }

  async function deactivateClerkUserFromWebhook(clerkId) {
    if (!clerkId) return;
    await pool.query(
      `UPDATE usuarios
       SET activo = false
       WHERE clerk_id = $1`,
      [clerkId]
    );
  }

  async function provisionUserFromClerk(clerkId) {
    const clerkUser = await fetchClerkUser(clerkId);
    const email = getPrimaryEmail(clerkUser);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingUserByClerk = await client.query(
        `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
         FROM usuarios u
         JOIN personas p ON p.id = u.persona_id
         WHERE u.clerk_id = $1`,
        [clerkId]
      );

      if (existingUserByClerk.rowCount > 0) {
        const reactivated = await client.query(
          `UPDATE usuarios
           SET activo = true
           WHERE clerk_id = $1
           RETURNING *`,
          [clerkId]
        );

        await client.query('COMMIT');
        return {
          ...existingUserByClerk.rows[0],
          ...reactivated.rows[0],
        };
      }

      const firstName = normalizeOptionalText(clerkUser.first_name);
      const lastName = normalizeOptionalText(clerkUser.last_name);
      const phone = normalizePhone(clerkUser.phone_numbers);

      let personaId;
      const existingPersona = email
        ? await client.query('SELECT * FROM personas WHERE email = $1', [email])
        : { rowCount: 0 };

      if (existingPersona.rowCount > 0) {
        personaId = existingPersona.rows[0].id;
        await client.query(
          `UPDATE personas
           SET nombre = COALESCE(NULLIF(nombre, ''), $1),
               apellido = COALESCE(NULLIF(apellido, ''), $2),
               telefono = COALESCE(telefono, $3)
           WHERE id = $4`,
          [firstName, lastName, phone, personaId]
        );
      } else {
        const createdPersona = await client.query(
          `INSERT INTO personas (nombre, apellido, email, telefono, perfil_completo)
           VALUES ($1, $2, $3, $4, false)
           RETURNING *`,
          [firstName, lastName, email, phone]
        );
        personaId = createdPersona.rows[0].id;
      }

      const createdUser = await client.query(
        `INSERT INTO usuarios (persona_id, clerk_id, activo)
         VALUES ($1, $2, true)
         RETURNING *`,
        [personaId, clerkId]
      );

      await ensureClienteRole(client, personaId);

      const fullUser = await client.query(
        `SELECT u.*, p.nombre, p.apellido, p.email, p.perfil_completo
         FROM usuarios u
         JOIN personas p ON p.id = u.persona_id
         WHERE u.id = $1`,
        [createdUser.rows[0].id]
      );

      await client.query('COMMIT');
      return fullUser.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapProvisionError(error);
    } finally {
      client.release();
    }
  }

  async function completeUserProfile(clerkId, payload) {
    const result = await pool.query(
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

    if (result.rowCount === 0) {
      throw new HttpError(404, 'Usuario no encontrado o inactivo.');
    }
    return result.rows[0];
  }

  return {
    getOrCreateUser,
    createUserWithClerk,
    getUserProfile,
    completeUserProfile,
    deactivateUser,
    syncClerkUserFromWebhook,
    deactivateClerkUserFromWebhook,
  };
}

// Instancia default usada por los routers en producción.
const defaultService = createAuthService();

module.exports = {
  ...defaultService,
  createAuthService,
};
