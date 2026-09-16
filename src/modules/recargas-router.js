// Rutas de recarga de celulares.

const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const createIdempotency = require('../middlewares/idempotency');
const recargasService = require('./recargas-service');
const { aTransaccionPublica } = require('../dtos');

const router = express.Router();
const idempotency = createIdempotency(pool);

const recargaSchema = z.object({
  cuenta_id: uuidLike,
  operadora_id: z.string().trim().min(1).max(60),
  numero: z.string().trim().regex(/^\d{10}$/, 'El número va con 10 dígitos, sin 0 ni 15.'),
  monto: z.coerce.number().positive(),
});

router.get(
  '/operadoras',
  asyncHandler(async (_req, res) => {
    res.json(await recargasService.listarOperadoras());
  })
);

router.post(
  '/',
  idempotency,
  validate(recargaSchema),
  asyncHandler(async (req, res) => {
    const resultado = await recargasService.recargar({
      ...req.body,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
      idempotencyKey: req.get('Idempotency-Key') || null,
    });

    res.status(201).json({
      ...resultado,
      transaccion: aTransaccionPublica(resultado.transaccion),
    });
  })
);

module.exports = router;
