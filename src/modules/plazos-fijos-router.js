// Rutas de plazos fijos.

const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const { paginationSchema } = require('../utils/pagination');
const requerirRoles = require('../middlewares/require-roles');
const createIdempotency = require('../middlewares/idempotency');
const plazosFijosService = require('./plazos-fijos-service');
const { aPlazoFijoPublico } = require('../dtos');

const router = express.Router();
const idempotency = createIdempotency(pool);

const paramsSchema = z.object({ id: uuidLike });

const simulacionSchema = z.object({
  capital: z.coerce.number().positive(),
  dias: z.coerce.number().int().min(30).max(365),
  tna: z.coerce.number().nonnegative().nullable().optional(),
});

const constitucionSchema = simulacionSchema.extend({ cuenta_id: uuidLike });

const listadoSchema = paginationSchema.extend({
  estado: z.enum(['vigente', 'vencido', 'acreditado', 'cancelado_anticipado']).optional(),
});

router.post(
  '/simulaciones',
  validate(simulacionSchema),
  asyncHandler(async (req, res) => {
    res.json(await plazosFijosService.simular({
      capital: req.body.capital,
      dias: req.body.dias,
      tna: req.body.tna ?? null,
    }));
  })
);

// Igual que en préstamos: va antes de `/:id` para que Express no lo matchee
// como un identificador.
router.post(
  '/marcar-vencidos',
  requerirRoles(['admin', 'operador', 'tesoreria']),
  asyncHandler(async (_req, res) => {
    res.json(await plazosFijosService.marcarVencidos());
  })
);

router.post(
  '/',
  idempotency,
  validate(constitucionSchema),
  asyncHandler(async (req, res) => {
    const pf = await plazosFijosService.constituir({
      cuentaId: req.body.cuenta_id,
      capital: req.body.capital,
      dias: req.body.dias,
      tna: req.body.tna ?? null,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
    });
    res.status(201).json(aPlazoFijoPublico(pf));
  })
);

router.get(
  '/',
  validate(listadoSchema, 'query'),
  asyncHandler(async (req, res) => {
    const resultado = await plazosFijosService.listar({
      usuarioActual: req.currentUser,
      estado: req.query.estado ?? null,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ...resultado, data: resultado.data.map(aPlazoFijoPublico) });
  })
);

router.post(
  '/:id/acreditacion',
  validate(paramsSchema, 'params'),
  idempotency,
  validate(z.object({ anticipada: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const resultado = await plazosFijosService.acreditar({
      plazoFijoId: req.params.id,
      anticipada: req.body?.anticipada ?? false,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
    });
    res.json({
      plazo_fijo: aPlazoFijoPublico(resultado.plazo_fijo),
      total_acreditado: resultado.total_acreditado,
      dias_transcurridos: resultado.dias_transcurridos,
      anticipada: resultado.anticipada,
    });
  })
);

module.exports = router;
