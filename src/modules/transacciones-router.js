const express = require('express');
const { z } = require('zod');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const { uuidLike } = require('../utils/schemas');
const { toPublicTransaccion } = require('../dtos');
const service = require('./transacciones-service');
const pool = require('../db/pool');
const createIdempotency = require('../middlewares/idempotency');

const router = express.Router();
const idempotency = createIdempotency(pool);

// ── Schemas de validación ───────────────────────────────────────────────────

const idParamsSchema = z.object({
  id: uuidLike,
});

const transferSchema = z
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

const centralContractTransferSchema = z.object({
  cbuOrigen: z.string().trim().length(22),
  cbuDestino: z.string().trim().length(22),
  importe: z.coerce.number().positive(),
  saldoOrigen: z.coerce.number().nonnegative(),
});

const resolveRecipientSchema = z
  .object({
    alias: z.string().trim().min(1).optional(),
    cbu: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.alias || data.cbu), {
    message: 'Debes indicar un alias o un CBU.',
  });

// ── Rutas ───────────────────────────────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await service.listForUser(req.currentUser);
    res.json({
      count: rows.length,
      data: rows.map(toPublicTransaccion),
    });
  })
);

router.get(
  '/destinatario/resolver',
  validate(resolveRecipientSchema, 'query'),
  asyncHandler(async (req, res) => {
    const response = await service.resolveRecipient({
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
    const row = await service.getByIdForUser(req.params.id, req.currentUser);
    res.json(toPublicTransaccion(row));
  })
);

router.post(
  '/',
  idempotency,
  validate(centralContractTransferSchema),
  asyncHandler(async (req, res) => {
    const { cbuOrigen, cbuDestino, importe, saldoOrigen } = req.body;

    const result = await service.createContractTransfer({
      cbuOrigen,
      cbuDestino,
      importe,
      saldoOrigen,
      currentUser: req.currentUser,
      ipAddress: req.ip || null,
    });

    res.status(result.statusCode).json({
      message:
        result.stateLabel === 'aprobada'
          ? 'Transacción aprobada'
          : 'Saldo insuficiente. La transacción queda registrada como rechazada.',
      transactionId:
        result.central?.transactionId || result.transaction.central_transaction_id || result.transaction.id,
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
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const result = await service.operate({
      ...req.body,
      currentUser: req.currentUser,
      ipAddress: req.ip || null,
    });

    res.status(result.statusCode).json({
      ...toPublicTransaccion(result.transaction),
      central: result.central,
    });
  })
);

// Cualquier usuario autenticado puede sincronizar sus transferencias entrantes.
router.post(
  '/sync-incoming',
  asyncHandler(async (req, res) => {
    const result = await service.syncIncomingForUser(req.currentUser);
    res.json(result);
  })
);

module.exports = router;
