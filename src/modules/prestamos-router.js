// Rutas de préstamos y plazos fijos. Delgadas: validan, delegan y mapean al DTO.

const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const { paginationSchema } = require('../utils/pagination');
const requerirRoles = require('../middlewares/require-roles');
const createIdempotency = require('../middlewares/idempotency');
const prestamosService = require('./prestamos-service');
const { aPrestamoPublico, aCuotaPublica } = require('../dtos');

/** Una solicitud pendiente, con quién la pidió: el gerente necesita ver ambas. */
function aSolicitudPendiente(fila) {
  return {
    ...aPrestamoPublico(fila),
    solicitante: {
      nombre: fila.nombre,
      apellido: fila.apellido,
      dni: fila.dni,
      email: fila.email,
    },
  };
}

const router = express.Router();
const idempotency = createIdempotency(pool);

const paramsSchema = z.object({ id: uuidLike });

const simulacionSchema = z.object({
  capital: z.coerce.number().positive(),
  cuotas: z.coerce.number().int().min(1).max(72),
  tna: z.coerce.number().nonnegative().nullable().optional(),
  fecha_otorgamiento: z.iso.date().nullable().optional(),
});

const solicitudSchema = z.object({
  cuenta_id: uuidLike,
  capital: z.coerce.number().positive(),
  cuotas: z.coerce.number().int().min(1).max(72),
  tna: z.coerce.number().nonnegative().nullable().optional(),
});

const listadoSchema = paginationSchema.extend({
  estado: z.enum(['vigente', 'cancelado', 'en_mora']).optional(),
});

// La simulación no persiste nada, así que no lleva idempotencia ni permisos
// especiales: cualquier cliente autenticado puede simular antes de decidir.
router.post(
  '/simulaciones',
  validate(simulacionSchema),
  asyncHandler(async (req, res) => {
    const simulacion = await prestamosService.simular({
      capital: req.body.capital,
      cuotas: req.body.cuotas,
      tna: req.body.tna ?? null,
      fechaOtorgamiento: req.body.fecha_otorgamiento ?? null,
    });
    res.json(simulacion);
  })
);

// ── La bandeja del gerente ──────────────────────────────────────────────────
// Van ANTES de `/:id` por la misma razón que el barrido de mora: si no,
// Express leería "pendientes" como un id y fallaría la validación de UUID.

// El gerente resuelve solicitudes; el admin puede hacerlo también, porque es
// quien cubre cuando no hay gerente disponible.
const puedeResolverSolicitudes = requerirRoles(
  ['gerente', 'admin'],
  'Sólo un gerente puede aprobar o rechazar un préstamo.'
);

router.get(
  '/pendientes',
  puedeResolverSolicitudes,
  asyncHandler(async (_req, res) => {
    const pendientes = await prestamosService.listarPendientes();
    res.json({ count: pendientes.length, data: pendientes.map(aSolicitudPendiente) });
  })
);

const decisionSchema = z.object({
  // Obligatorio: la decisión tiene que quedar explicada en la auditoría.
  motivo: z.string().trim().min(10, 'Escribí el motivo de la decisión: al menos 10 caracteres.').max(500),
  environment: z.enum(['test', 'prod']).optional(),
});

router.post(
  '/:id/aprobacion',
  puedeResolverSolicitudes,
  validate(paramsSchema, 'params'),
  validate(decisionSchema),
  asyncHandler(async (req, res) => {
    const prestamo = await prestamosService.resolverSolicitud({
      prestamoId: req.params.id,
      aprobar: true,
      motivo: req.body.motivo,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
      environment: req.body.environment,
    });
    res.json(aPrestamoPublico(prestamo));
  })
);

router.post(
  '/:id/rechazo',
  puedeResolverSolicitudes,
  validate(paramsSchema, 'params'),
  validate(decisionSchema),
  asyncHandler(async (req, res) => {
    const prestamo = await prestamosService.resolverSolicitud({
      prestamoId: req.params.id,
      aprobar: false,
      motivo: req.body.motivo,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });
    res.json(aPrestamoPublico(prestamo));
  })
);

// Barrido de mora. Va ANTES de `/:id` porque si no Express matchearía
// "actualizar-mora" como un id y fallaría la validación de UUID. Es el mismo
// bug que tuvo en su momento `/transacciones/destinatario/resolver`.
router.post(
  '/actualizar-mora',
  requerirRoles(['admin', 'operador', 'tesoreria']),
  asyncHandler(async (req, res) => {
    const resumen = await prestamosService.actualizarMora({ environment: req.body?.environment });
    res.json(resumen);
  })
);

router.post(
  '/',
  idempotency,
  validate(solicitudSchema),
  asyncHandler(async (req, res) => {
    const prestamo = await prestamosService.otorgar({
      cuentaId: req.body.cuenta_id,
      capital: req.body.capital,
      cuotas: req.body.cuotas,
      tna: req.body.tna ?? null,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });
    res.status(201).json(aPrestamoPublico(prestamo));
  })
);

router.get(
  '/',
  validate(listadoSchema, 'query'),
  asyncHandler(async (req, res) => {
    const resultado = await prestamosService.listar({
      usuarioActual: req.usuarioActual,
      estado: req.query.estado ?? null,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({ ...resultado, data: resultado.data.map(aPrestamoPublico) });
  })
);

router.get(
  '/:id',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const prestamo = await prestamosService.obtenerPorId({
      prestamoId: req.params.id,
      usuarioActual: req.usuarioActual,
    });
    res.json(aPrestamoPublico(prestamo));
  })
);

router.post(
  '/:id/pagos',
  validate(paramsSchema, 'params'),
  idempotency,
  asyncHandler(async (req, res) => {
    const resultado = await prestamosService.pagarCuota({
      prestamoId: req.params.id,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });
    res.status(201).json({
      cuota: aCuotaPublica(resultado.cuota),
      cuotas_pendientes: resultado.cuotas_pendientes,
      saldo_deuda: resultado.saldo_deuda,
      estado_prestamo: resultado.estado_prestamo,
    });
  })
);

router.post(
  '/:id/precancelacion',
  validate(paramsSchema, 'params'),
  idempotency,
  asyncHandler(async (req, res) => {
    const resultado = await prestamosService.precancelar({
      prestamoId: req.params.id,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });
    res.json({
      prestamo: aPrestamoPublico(resultado.prestamo),
      capital_pagado: resultado.capital_pagado,
    });
  })
);

module.exports = router;
