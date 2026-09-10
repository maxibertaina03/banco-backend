const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { clerkAuth, extraerIdUsuarioDeClerk } = require('../middlewares/clerk-auth');
const authService = require('./auth-service');
const centralBankService = require('./central-bank-service');
const { uuidLike } = require('../utils/schemas');
const HttpError = require('../utils/http-error');

const router = express.Router();
const completarPerfilSchema = z.object({
  nombre: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
  dni: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  telefono: z.string().trim().min(1),
  fecha_nacimiento: z.iso.date(),
});

// Edición parcial del perfil ya completo. A diferencia del PUT, no exige
// todos los campos: el cliente manda solo lo que cambió. NO toca
// `perfil_completo` (si ya era true, sigue siendo true).
const editarPerfilSchema = z
  .object({
    nombre: z.string().trim().min(1).optional(),
    apellido: z.string().trim().min(1).optional(),
    telefono: z.string().trim().min(6).optional(),
    email: z.email().trim().toLowerCase().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Debes enviar al menos un campo para actualizar.',
  });

/**
 * POST /auth/login
 * Autentica al usuario con Clerk y lo sincroniza con la BD.
 * Requiere: token JWT de Clerk en header Authorization
 */
router.post(
  '/login',
  clerkAuth,
  asyncHandler(async (req, res) => {
    const clerkId = extraerIdUsuarioDeClerk(req.auth);

    // Obtener o crear usuario en BD
    const user = await authService.obtenerOCrearUsuario(clerkId);

    res.json({
      message: 'Login exitoso.',
      user: {
        id: user.id,
        persona_id: user.persona_id,
        nombre: user.nombre,
        apellido: user.apellido,
        email: user.email,
        activo: user.activo,
        perfil_completo: user.perfil_completo,
      },
    });
  })
);

/**
 * POST /auth/register
 * Registra una nueva persona y la enlaza con Clerk.
 * Body: { persona_id }
 */
router.post(
  '/register',
  clerkAuth,
  validate(
    z.object({
      persona_id: uuidLike,
    })
  ),
  asyncHandler(async (req, res) => {
    const { persona_id } = req.body;
    const clerkId = extraerIdUsuarioDeClerk(req.auth);

    if (!clerkId) {
      throw new HttpError(400, 'No se pudo obtener el usuario autenticado desde Clerk.');
    }

    const user = await authService.crearUsuarioConClerk(persona_id, clerkId);

    res.status(201).json({
      message: 'Usuario registrado exitosamente.',
      user,
    });
  })
);

/**
 * GET /auth/perfil
 * Obtiene el perfil completo del usuario autenticado.
 * Requiere: token JWT de Clerk autorizado en header
 */
router.get(
  '/perfil',
  clerkAuth,
  asyncHandler(async (req, res) => {
    const clerkId = extraerIdUsuarioDeClerk(req.auth);

    const perfil = await authService.obtenerPerfilDeUsuario(clerkId);

    res.json({
      message: 'Perfil obtenido.',
      user: perfil,
    });
  })
);

/**
 * PUT /auth/perfil
 * Completa o actualiza los datos de negocio del usuario autenticado.
 */
router.put(
  '/perfil',
  clerkAuth,
  validate(completarPerfilSchema),
  asyncHandler(async (req, res) => {
    const clerkId = extraerIdUsuarioDeClerk(req.auth);

    const perfil = await authService.completarPerfilDeUsuario(clerkId, req.body);

    // Best-effort: register person with Central Bank after perfil completion.
    // Failures here are non-fatal — the perfil update already succeeded.
    let centralBank = null;
    try {
      const centralResult = await centralBankService.registrarPersonaLocalDesdeCentral(
        {
          nombre: perfil.nombre,
          apellido: perfil.apellido,
          dni: perfil.dni,
          email: perfil.email,
          telefono: perfil.telefono,
          environment: 'test',
        },
        { usuarioId: perfil.id, ipAddress: req.ip || null }
      );
      centralBank = {
        status: centralResult.status,
        message: centralResult.message,
        cbu: centralResult.cuenta?.cbu || null,
        alias: centralResult.cuenta?.alias || null,
      };
    } catch {
      // swallow — Central Bank unavailable or persona already registered
    }

    res.json({
      message: 'Perfil completado.',
      user: perfil,
      centralBank,
    });
  })
);

/**
 * PATCH /auth/perfil
 * Actualización parcial del perfil (nombre, apellido, teléfono, email).
 * Solo para usuarios con perfil ya completo.
 */
router.patch(
  '/perfil',
  clerkAuth,
  validate(editarPerfilSchema),
  asyncHandler(async (req, res) => {
    const clerkId = extraerIdUsuarioDeClerk(req.auth);
    const perfil = await authService.actualizarPerfilDeUsuario(clerkId, req.body);
    res.json({ message: 'Perfil actualizado.', user: perfil });
  })
);

/**
 * POST /auth/logout
 * Stateless JWT: el token expira por sí solo en Clerk.
 * El backend solo confirma recepción; la invalidación real ocurre
 * en el cliente (Clerk SignOut) que revoca la sesión en Clerk.
 */
router.post(
  '/logout',
  clerkAuth,
  asyncHandler(async (_req, res) => {
    res.json({ message: 'Sesión cerrada.' });
  })
);

module.exports = router;
