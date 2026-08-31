const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const clerkAuth = require('../middlewares/clerk-auth');
const HttpError = require('../utils/http-error');
const { MAX_HISTORY_MESSAGES, MAX_MESSAGE_LENGTH, createChatbotService } = require('./chatbot-service');

const router = express.Router();
const service = createChatbotService();
const chatbotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Alcanzaste el límite temporal del asistente. Intentá más tarde.' },
});

const messageSchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  history: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    })
  ).max(MAX_HISTORY_MESSAGES).default([]),
});

router.post(
  '/message',
  clerkAuth,
  chatbotLimiter,
  validate(messageSchema),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      'SELECT id, persona_id, activo FROM usuarios WHERE clerk_id = $1',
      [req.clerkUserId]
    );

    if (result.rowCount === 0 || !result.rows[0].activo) {
      throw new HttpError(403, 'No existe un perfil bancario activo para este usuario.');
    }

    const reply = await service.sendMessage({ ...req.body, usuarioActual: result.rows[0] });
    res.json({ reply });
  })
);

module.exports = router;