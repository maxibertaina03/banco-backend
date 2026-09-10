// Service de autenticación con Clerk + sincronización de usuarios.
//
// Patrón: factory `createAuthService({ pool, clerkApi })` para tests con
// dependency injection. El `module.exports` por defecto usa la instancia real,
// así que los consumidores (auth-router, clerk-webhook-router) no cambian.
//
// El SQL vive en ./auth/auth-queries.js y las normalizaciones puras en
// ./auth/auth-helpers.js. Este archivo solo orquesta: decide el flujo, maneja
// las transacciones (BEGIN/COMMIT/ROLLBACK) y traduce errores.

const axios = require('axios');
const HttpError = require('../utils/http-error');
const env = require('../config/env');
const realPool = require('../db/pool');
const q = require('./auth/auth-queries');
const {
  getPrimaryEmail,
  normalizeOptionalText,
  normalizePhone,
  mapProvisionError,
} = require('./auth/auth-helpers');

const realClerkApi = axios.create({
  baseURL: 'https://api.clerk.com/v1',
  headers: {
    Authorization: `Bearer ${env.clerkSecretKey}`,
    'Content-Type': 'application/json',
  },
});

function createAuthService({ pool = realPool, clerkApi = realClerkApi } = {}) {
  // ── Helpers que necesitan deps (pool/clerkApi) ────────────────────────────

  async function ensureClienteRole(client, personaId) {
    const roleResult = await q.selectRoleByName(client, 'cliente');
    if (roleResult.rowCount === 0) return;
    await q.insertarRolDePersona(client, personaId, roleResult.rows[0].id);
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
  async function obtenerOCrearUsuario(clerkId) {
    const result = await q.selectActiveUserWithPersona(pool, clerkId);
    if (result.rowCount > 0) {
      return result.rows[0];
    }
    return aprovisionarUsuarioDesdeClerk(clerkId);
  }

  /**
   * Crea un nuevo usuario enlazando una persona existente con Clerk.
   * Se da por supuesto que la persona ya existe.
   */
  async function crearUsuarioConClerk(personaId, clerkId) {
    const personaResult = await q.selectPersonaById(pool, personaId);
    if (personaResult.rowCount === 0) {
      throw new HttpError(404, `No existe la persona con id ${personaId}.`);
    }

    const existingByPersona = await q.selectUsuarioByPersonaId(pool, personaId);

    const usuarioExistente = await q.selectUsuarioByClerkId(pool, clerkId);
    if (usuarioExistente.rowCount > 0 && usuarioExistente.rows[0].persona_id !== personaId) {
      throw new HttpError(400, 'Ya existe un usuario con ese clerk_id.');
    }

    if (existingByPersona.rowCount > 0) {
      const result = await q.reassignClerkIdToPersona(pool, clerkId, personaId);
      return result.rows[0];
    }

    const result = await q.insertUsuario(pool, personaId, clerkId);
    return result.rows[0];
  }

  /**
   * Obtiene el perfil completo del usuario autenticado. Si no se encuentra,
   * fuerza aprovisionamiento y reintenta una sola vez.
   */
  async function obtenerPerfilDeUsuario(clerkId) {
    const result = await q.seleccionarPerfilDeUsuario(pool, clerkId);

    if (result.rowCount === 0) {
      await obtenerOCrearUsuario(clerkId);
      return obtenerPerfilDeUsuario(clerkId);
    }

    const user = result.rows[0];
    const rolesResult = await q.selectRolesByPersona(pool, user.persona_id);
    user.roles = rolesResult.rows;
    return user;
  }

  /** Desactiva un usuario (logout "suave"). */
  async function desactivarUsuario(clerkId) {
    const result = await q.deactivateUserReturning(pool, clerkId);
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
  async function sincronizarUsuarioDeClerkPorWebhook(clerkUser) {
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

      const usuarioExistente = await q.selectUsuarioIdAndPersona(client, clerkId);

      if (usuarioExistente.rowCount > 0) {
        const personaId = usuarioExistente.rows[0].persona_id;

        await q.reactivateUsuarioById(client, usuarioExistente.rows[0].id);
        await q.mergePersonaIfIncomplete(client, { firstName, lastName, email, phone, personaId });

        await client.query('COMMIT');
        return;
      }

      let personaId;
      const existingPersona = email
        ? await q.selectPersonaIdByEmail(client, email)
        : { rowCount: 0 };

      if (existingPersona.rowCount > 0) {
        personaId = existingPersona.rows[0].id;
        await q.fillEmptyPersonaFields(client, { firstName, lastName, phone, personaId });
      } else {
        const createdPersona = await q.insertPersonaReturningId(client, { firstName, lastName, email, phone });
        personaId = createdPersona.rows[0].id;
      }

      await q.upsertUsuarioByClerkId(client, personaId, clerkId);
      await ensureClienteRole(client, personaId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapProvisionError(error);
    } finally {
      client.release();
    }
  }

  async function desactivarUsuarioDeClerkPorWebhook(clerkId) {
    if (!clerkId) return;
    await q.desactivarUsuario(pool, clerkId);
  }

  async function aprovisionarUsuarioDesdeClerk(clerkId) {
    const clerkUser = await fetchClerkUser(clerkId);
    const email = getPrimaryEmail(clerkUser);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existingUserByClerk = await q.selectUserWithPersonaAnyState(client, clerkId);

      if (existingUserByClerk.rowCount > 0) {
        const reactivated = await q.reactivateUsuarioByClerkId(client, clerkId);
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
        ? await q.selectPersonaByEmail(client, email)
        : { rowCount: 0 };

      if (existingPersona.rowCount > 0) {
        personaId = existingPersona.rows[0].id;
        await q.fillEmptyPersonaFields(client, { firstName, lastName, phone, personaId });
      } else {
        const createdPersona = await q.insertPersonaReturningAll(client, { firstName, lastName, email, phone });
        personaId = createdPersona.rows[0].id;
      }

      const createdUser = await q.insertUsuario(client, personaId, clerkId);

      await ensureClienteRole(client, personaId);

      const fullUser = await q.selectFullUserById(client, createdUser.rows[0].id);

      await client.query('COMMIT');
      return fullUser.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapProvisionError(error);
    } finally {
      client.release();
    }
  }

  // Actualización parcial del perfil. Solo toca los campos enviados; el
  // resto queda intacto. NO modifica perfil_completo, dni ni fecha_nacimiento
  // (datos sensibles que deben pasar por flujo de verificación específico).
  async function actualizarPerfilDeUsuario(clerkId, payload) {
    const allowed = ['nombre', 'apellido', 'telefono', 'email'];
    const updates = [];
    const values = [];

    for (const field of allowed) {
      if (payload[field] !== undefined) {
        updates.push(`${field} = $${values.length + 1}`);
        values.push(payload[field]);
      }
    }

    if (updates.length === 0) {
      throw new HttpError(400, 'No hay campos para actualizar.');
    }

    values.push(clerkId);
    const clerkIdParam = `$${values.length}`;

    const result = await q.updatePersonaPartial(pool, updates.join(', '), clerkIdParam, values);

    if (result.rowCount === 0) {
      throw new HttpError(404, 'Usuario no encontrado o inactivo.');
    }
    return result.rows[0];
  }

  async function completarPerfilDeUsuario(clerkId, payload) {
    const result = await q.completarPerfil(pool, payload, clerkId);
    if (result.rowCount === 0) {
      throw new HttpError(404, 'Usuario no encontrado o inactivo.');
    }
    return result.rows[0];
  }

  return {
    obtenerOCrearUsuario,
    crearUsuarioConClerk,
    obtenerPerfilDeUsuario,
    completarPerfilDeUsuario,
    actualizarPerfilDeUsuario,
    desactivarUsuario,
    sincronizarUsuarioDeClerkPorWebhook,
    desactivarUsuarioDeClerkPorWebhook,
  };
}

// Instancia default usada por los routers en producción.
const defaultService = createAuthService();

module.exports = {
  ...defaultService,
  createAuthService,
};
