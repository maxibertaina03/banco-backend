const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { clerkAuth, extractClerkUserId } = require('../middlewares/clerk-auth');
const authService = require('./auth-service');
const { uuidLike } = require('../utils/schemas');
const HttpError = require('../utils/http-error');

const router = express.Router();
const completeProfileSchema = z.object({
  nombre: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
  dni: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  telefono: z.string().trim().min(1),
  fecha_nacimiento: z.iso.date(),
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
    const clerkId = extractClerkUserId(req.auth);

    // Obtener o crear usuario en BD
    const user = await authService.getOrCreateUser(clerkId);

    res.json({
      message: 'Login exitoso.',
      user: {
        id: user.id,
        persona_id: user.persona_id,
        clerk_id: user.clerk_id,
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
    const clerkId = extractClerkUserId(req.auth);

    if (!clerkId) {
      throw new HttpError(400, 'No se pudo obtener el usuario autenticado desde Clerk.');
    }

    const user = await authService.createUserWithClerk(persona_id, clerkId);

    res.status(201).json({
      message: 'Usuario registrado exitosamente.',
      user,
    });
  })
);

/**
 * GET /auth/profile
 * Obtiene el perfil completo del usuario autenticado.
 * Requiere: token JWT de Clerk autorizado en header
 */
router.get(
  '/profile',
  clerkAuth,
  asyncHandler(async (req, res) => {
    const clerkId = extractClerkUserId(req.auth);

    const profile = await authService.getUserProfile(clerkId);

    res.json({
      message: 'Perfil obtenido.',
      user: profile,
    });
  })
);

/**
 * PUT /auth/profile
 * Completa o actualiza los datos de negocio del usuario autenticado.
 */
router.put(
  '/profile',
  clerkAuth,
  validate(completeProfileSchema),
  asyncHandler(async (req, res) => {
    const clerkId = extractClerkUserId(req.auth);

    const profile = await authService.completeUserProfile(clerkId, req.body);

    res.json({
      message: 'Perfil completado.',
      user: profile,
    });
  })
);

/**
 * POST /auth/logout
 * Desautentica al usuario desactivando su cuenta.
 * Requiere: token JWT de Clerk autorizado
 */
router.post(
  '/logout',
  clerkAuth,
  asyncHandler(async (req, res) => {
    const clerkId = extractClerkUserId(req.auth);

    await authService.deactivateUser(clerkId);

    res.json({
      message: 'Logout exitoso.',
    });
  })
);

module.exports = router;
