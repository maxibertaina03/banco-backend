const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
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
  chatbotLimiter,
  validate(messageSchema),
  asyncHandler(async (req, res) => {
    const reply = await service.sendMessage({ ...req.body, usuarioActual: req.usuarioActual });
    res.json({ reply });
  })
);

module.exports = router;