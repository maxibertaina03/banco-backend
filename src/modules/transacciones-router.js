const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const { aTransaccionPublica } = require('../dtos');
const service = require('./transacciones-service');
const pool = require('../db/pool');
const createIdempotency = require('../middlewares/idempotency');
const requerirRoles = require('../middlewares/require-roles');

const router = express.Router();
const idempotency = createIdempotency(pool);

// ── Schemas de validación ───────────────────────────────────────────────────

const idParamsSchema = z.object({
  id: uuidLike,
});

const transferenciaSchema = z
  .object({
    tipo_transaccion_id: uuidLike,
    cuenta_origen_id: uuidLike,
    cuenta_destino_id: uuidLike.nullable().optional(),
    destinatario_id: uuidLike.nullable().optional(),
    cbu_destino: z.string().trim().min(1).nullable().optional(),
    monto: z.coerce.number().positive(),
    descripcion: z.string().trim().min(1).nullable().optional(),
    estado: z.enum(['pendiente', 'completada', 'rechazada']).optional(),
  })
  .refine((data) => Boolean(data.cuenta_destino_id || data.destinatario_id || data.cbu_destino), {
    message: 'Debes indicar una cuenta destino, un destinatario o un CBU de destino.',
  });

const transferenciaPorContratoSchema = z.object({
  cbuOrigen: z.string().trim().length(22),
  cbuDestino: z.string().trim().length(22),
  importe: z.coerce.number().positive(),
  saldoOrigen: z.coerce.number().nonnegative(),
});

const resolverDestinatarioSchema = z
  .object({
    alias: z.string().trim().min(1).optional(),
    cbu: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.alias || data.cbu), {
    message: 'Debes indicar un alias o un CBU.',
  });

// Depósito en efectivo (sucursal): un operador/admin/tesorería acredita
// efectivo físico a la cuenta de un cliente.
const depositSchema = z.object({
  cuenta_destino_id: uuidLike,
  monto: z.coerce.number().positive(),
  descripcion: z.string().trim().min(1).max(140).nullable().optional(),
});

// ── Rutas ───────────────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await service.listarParaUsuario(req.usuarioActual);
    res.json({
      count: rows.length,
      data: rows.map(aTransaccionPublica),
    });
  })
);

router.get(
  '/destinatario/resolver',
  validate(resolverDestinatarioSchema, 'query'),
  asyncHandler(async (req, res) => {
    const response = await service.resolverDestinatario({
      alias: req.query.alias,
      cbu: req.query.cbu,
    });
    res.json(response);
  })
);

router.get(
  '/:id',
  validate(idParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const row = await service.obtenerPorIdParaUsuario(req.params.id, req.usuarioActual);
    res.json(aTransaccionPublica(row));
  })
);

router.post(
  '/',
  idempotency,
  validate(transferenciaPorContratoSchema),
  asyncHandler(async (req, res) => {
    const { cbuOrigen, cbuDestino, importe, saldoOrigen } = req.body;

    const result = await service.crearTransferenciaPorContrato({
      cbuOrigen,
      cbuDestino,
      importe,
      saldoOrigen,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });

    res.status(result.statusCode).json({
      message:
        result.stateLabel === 'aprobada'
          ? 'Transacción aprobada'
          : 'Saldo insuficiente. La transacción queda registrada como rechazada.',
      idTransaccion:
        result.central?.transaccionId || result.transaccion.central_transaction_id || result.transaccion.id,
      estado: result.stateLabel,
      cbuOrigen,
      cbuDestino: result.effectiveDestinationCbu,
      importe,
      nombreOrigen: result.originName,
      nombreDestino: result.destinationName,
    });
  })
);

router.post(
  '/operar',
  idempotency,
  validate(transferenciaSchema),
  asyncHandler(async (req, res) => {
    const result = await service.operate({
      ...req.body,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });

    res.status(result.statusCode).json({
      ...aTransaccionPublica(result.transaccion),
      central: result.central,
    });
  })
);

// Cualquier usuario autenticado puede sincronizar sus transferencias entrantes.
router.post(
  '/sync-incoming',
  asyncHandler(async (req, res) => {
    const result = await service.syncIncomingForUser(req.usuarioActual);
    res.json(result);
  })
);

// Depósito en efectivo. Solo roles internos pueden hacerlo (simula que el
// cliente fue a una sucursal y el cajero registra el ingreso).
// Idempotency-Key se aplica igual que en transferencias para evitar
// dobles acreditaciones si el operador reintenta.
router.post(
  '/deposito',
  requerirRoles(['admin', 'operador', 'tesoreria']),
  idempotency,
  validate(depositSchema),
  asyncHandler(async (req, res) => {
    const result = await service.crearDeposito({
      ...req.body,
      usuarioActual: req.usuarioActual,
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      message: 'Depósito acreditado.',
      ...aTransaccionPublica(result.transaccion),
      destinationName: result.destinationName,
      destinationCbu: result.destinationCbu,
    });
  })
);

module.exports = router;
