const express = require('express');
const { verifyWebhook } = require('@clerk/express/webhooks');
const env = require('../config/env');
const asyncHandler = require('../utils/async-handler');
const authService = require('./auth-service');

const router = express.Router();

router.post(
  '/',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    if (!env.clerkWebhookSigningSecret) {
      return res.status(503).json({
        message: 'Falta configurar CLERK_WEBHOOK_SIGNING_SECRET.',
      });
    }

    const evt = await verifyWebhook(req, {
      signingSecret: env.clerkWebhookSigningSecret,
    });

    switch (evt.type) {
      case 'user.created':
      case 'user.updated':
        await authService.sincronizarUsuarioDeClerkPorWebhook(evt.data);
        break;
      case 'user.deleted':
        await authService.desactivarUsuarioDeClerkPorWebhook(evt.data?.id);
        break;
      default:
        break;
    }

    res.status(200).json({ ok: true });
  })
);

module.exports = router;
