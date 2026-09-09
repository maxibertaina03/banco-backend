// Rutas de tarjetas. Delgadas a propósito: validan, delegan en el service y
// mapean al DTO. La lógica de negocio vive en `tarjetas-service.js`.

const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const createIdempotency = require('../middlewares/idempotency');
const tarjetasService = require('./tarjetas-service');
const { aTarjetaPublica, aAutorizacionPublica } = require('../dtos');

const router = express.Router();
const idempotency = createIdempotency(pool);

const paramsSchema = z.object({ id: uuidLike });

const emisionSchema = z
  .object({
    persona_id: uuidLike,
    tipo: z.enum(['debito', 'credito']),
    cuenta_id: uuidLike.nullable().optional(),
    limite: z.coerce.number().positive().nullable().optional(),
  })
  .refine((d) => (d.tipo === 'debito' ? Boolean(d.cuenta_id) : Boolean(d.limite)), {
    message: 'Una tarjeta de débito necesita cuenta_id; una de crédito, limite.',
  });

const consumoSchema = z.object({
  comercio: z.string().trim().min(1).max(80),
  monto: z.coerce.number().positive(),
  cuotas: z.coerce.number().int().min(1).max(24).optional(),
});

const bloqueoSchema = z.object({
  accion: z.enum(['bloquear', 'desbloquear']),
});

const resumenQuerySchema = z.object({
  periodo: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'El período va en formato YYYY-MM.')
    .optional(),
});

router.post(
  '/',
  validate(emisionSchema),
  asyncHandler(async (req, res) => {
    const tarjeta = await tarjetasService.emitirTarjeta({
      personaId: req.body.persona_id,
      tipo: req.body.tipo,
      cuentaId: req.body.cuenta_id ?? null,
      limite: req.body.limite ?? null,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
    });
    res.status(201).json(aTarjetaPublica(tarjeta));
  })
);

// Autorización de un consumo. Lleva `Idempotency-Key` porque mueve plata en
// débito, y porque un doble envío no debe consumir el límite dos veces.
//
// El rechazo por saldo o límite NO es un error del sistema: la autorización se
// registra igual y se devuelve con 422, para que el cliente vea el motivo.
router.post(
  '/:id/autorizaciones',
  validate(paramsSchema, 'params'),
  idempotency,
  validate(consumoSchema),
  asyncHandler(async (req, res) => {
    const autorizacion = await tarjetasService.autorizarConsumo({
      tarjetaId: req.params.id,
      comercio: req.body.comercio,
      monto: req.body.monto,
      cuotas: req.body.cuotas ?? 1,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
    });

    res
      .status(autorizacion.estado === 'aprobada' ? 201 : 422)
      .json(aAutorizacionPublica(autorizacion));
  })
);

router.post(
  '/:id/bloqueo',
  validate(paramsSchema, 'params'),
  validate(bloqueoSchema),
  asyncHandler(async (req, res) => {
    const tarjeta = await tarjetasService.cambiarEstado({
      tarjetaId: req.params.id,
      accion: req.body.accion,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
    });
    res.json(aTarjetaPublica(tarjeta));
  })
);

router.get(
  '/:id/resumen',
  validate(paramsSchema, 'params'),
  validate(resumenQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const resumen = await tarjetasService.obtenerResumen({
      tarjetaId: req.params.id,
      periodo: req.query.periodo,
      usuarioActual: req.currentUser,
    });
    res.json({ ...resumen, consumos: resumen.consumos.map(aAutorizacionPublica) });
  })
);

module.exports = router;
