const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { clerkAuth } = require('../middlewares/clerk-auth');
const authService = require('./auth-service');
const { uuidLike } = require('../utils/schemas');

const router = express.Router();

/**
 * POST /auth/login
 * Autentica al usuario con Clerk y lo sincroniza con la BD.
 * Requiere: token JWT de Clerk en header Authorization
 */
router.post(
  '/login',
  clerkAuth,
  asyncHandler(async (req, res) => {
    const { clerk_id } = req.auth;

    // Obtener o crear usuario en BD
    const user = await authService.getOrCreateUser(clerk_id);

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
      },
    });
  })
);

/**
 * POST /auth/register
 * Registra una nueva persona y la enlaza con Clerk.
 * Body: { persona_id, clerk_id }
 */
router.post(
  '/register',
  validate(
    z.object({
      persona_id: uuidLike,
      clerk_id: z.string().trim().min(1),
    })
  ),
  asyncHandler(async (req, res) => {
    const { persona_id, clerk_id } = req.body;

    const user = await authService.createUserWithClerk(persona_id, clerk_id);

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
    const { clerk_id } = req.auth;

    const profile = await authService.getUserProfile(clerk_id);

    res.json({
      message: 'Perfil obtenido.',
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
    const { clerk_id } = req.auth;

    await authService.deactivateUser(clerk_id);

    res.json({
      message: 'Logout exitoso.',
    });
  })
);

module.exports = router;
