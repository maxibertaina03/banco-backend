const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { clerkAuth, optionalClerkAuth, extractClerkUserId } = require('../middlewares/clerk-auth');
const authService = require('./auth-service');
const { uuidLike } = require('../utils/schemas');
const HttpError = require('../utils/http-error');

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
  optionalClerkAuth,
  validate(
    z.object({
      persona_id: uuidLike,
      clerk_id: z.string().trim().min(1).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { persona_id, clerk_id: clerkIdFromBody } = req.body;
    const clerkIdFromToken = extractClerkUserId(req.auth);
    const clerkId = clerkIdFromToken || clerkIdFromBody;

    if (clerkIdFromBody && clerkIdFromToken && clerkIdFromBody !== clerkIdFromToken) {
      throw new HttpError(400, 'El clerk_id enviado no coincide con el usuario autenticado.');
    }

    if (!clerkId) {
      throw new HttpError(400, 'Debes enviar clerk_id o autenticarte con un token válido de Clerk.');
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

/**
 * POST /auth/login-custom
 * Login personalizado con email, DNI o username (nombre_apellido)
 * Body: { identifier: "email@test.com" | "12345678" | "Juan_Perez" }
 */
router.post(
  '/login-custom',
  validate(
    z.object({
      identifier: z.string().trim().min(1),
    })
  ),
  asyncHandler(async (req, res) => {
    const { identifier } = req.body;

    const user = await authService.loginWithIdentifier(identifier);

    res.json({
      message: 'Login exitoso.',
      user: {
        id: user.id,
        persona_id: user.persona_id,
        clerk_id: user.clerk_id,
        nombre: user.nombre,
        apellido: user.apellido,
        email: user.email,
        dni: user.dni,
        telefono: user.telefono,
        activo: user.activo,
        roles: user.roles,
      },
    });
  })
);

module.exports = router;
