const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const { uuidLike } = require('../utils/schemas');
const { isInternalUser } = require('../utils/access-control');
const { writeAuditLog } = require('../utils/audit');
const centralBankService = require('./central-bank-service');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    const isInternal = isInternalUser(user);
    const result = isInternal
      ? await pool.query('SELECT * FROM transacciones ORDER BY created_at DESC LIMIT 100')
      : await pool.query(
          `SELECT t.*
           FROM transacciones t
           JOIN cuentas origen ON origen.id = t.cuenta_origen_id
           LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
           WHERE origen.persona_id = $1 OR destino.persona_id = $1
           ORDER BY t.created_at DESC
           LIMIT 100`,
          [user.persona_id]
        );

    res.json({
      count: result.rows.length,
      data: result.rows,
    });
  })
);

router.get(
  '/:id',
  validate(
    z.object({
      id: uuidLike,
    }),
    'params'
  ),
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    const isInternal = isInternalUser(user);
    const result = isInternal
      ? await pool.query('SELECT * FROM transacciones WHERE id = $1', [req.params.id])
      : await pool.query(
          `SELECT t.*
           FROM transacciones t
           JOIN cuentas origen ON origen.id = t.cuenta_origen_id
           LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
           WHERE t.id = $1 AND (origen.persona_id = $2 OR destino.persona_id = $2)`,
          [req.params.id, user.persona_id]
        );

    if (result.rowCount === 0) {
      throw new HttpError(404, `No existe la transacción con id ${req.params.id}.`);
    }

    res.json(result.rows[0]);
  })
);

const transferSchema = z.object({
  tipo_transaccion_id: uuidLike,
  cuenta_origen_id: uuidLike,
  cuenta_destino_id: uuidLike.nullable().optional(),
  destinatario_id: uuidLike.nullable().optional(),
  cbu_destino: z.string().trim().min(1).nullable().optional(),
  monto: z.coerce.number().positive(),
  descripcion: z.string().trim().min(1).nullable().optional(),
  estado: z.enum(['pendiente', 'completada', 'rechazada']).optional(),
});

const resolveRecipientSchema = z
  .object({
    alias: z.string().trim().min(1).optional(),
    cbu: z.string().trim().min(1).optional(),
  })
  .refine((data) => Boolean(data.alias || data.cbu), {
    message: 'Debes indicar un alias o un CBU.',
  });

function findStringInPayload(payload, keys) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    for (const key of keys) {
      const value = current[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

function findFullNameInPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    const name = [current.nombre, current.apellido]
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim())
      .join(' ');

    if (name) {
      return name;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

router.get(
  '/destinatario/resolver',
  validate(resolveRecipientSchema, 'query'),
  asyncHandler(async (req, res) => {
    const alias = typeof req.query.alias === 'string' ? req.query.alias.trim() : null;
    const cbu = typeof req.query.cbu === 'string' ? req.query.cbu.trim() : null;
    const centralData = alias
      ? await centralBankService.findPersonByAlias(alias)
      : await centralBankService.findPersonByCbu(cbu);

    res.json({
      alias: findStringInPayload(centralData, ['alias']) || alias || null,
      cbu: centralBankService.extractCentralCbu(centralData) || cbu || null,
      titular: findFullNameInPayload(centralData),
      banco: findStringInPayload(centralData, ['bankName', 'bank_name', 'banco', 'nombreBanco']),
      raw: centralData,
    });
  })
);

router.post(
  '/operar',
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        tipo_transaccion_id,
        cuenta_origen_id,
        cuenta_destino_id = null,
        destinatario_id = null,
        cbu_destino = null,
        monto,
        descripcion = null,
        estado = 'completada',
      } = req.body;

      await client.query('BEGIN');

      const originResult = await client.query(
        'SELECT * FROM cuentas WHERE id = $1 FOR UPDATE',
        [cuenta_origen_id]
      );

      if (originResult.rowCount === 0) {
        throw new HttpError(404, `No existe la cuenta de origen ${cuenta_origen_id}.`);
      }

      const origin = originResult.rows[0];
      if (!origin.activa) {
        throw new HttpError(400, 'La cuenta de origen no está activa.');
      }

      if (!isInternalUser(req.currentUser) && origin.persona_id !== req.currentUser.persona_id) {
        throw new HttpError(403, 'No puedes operar sobre una cuenta que no te pertenece.');
      }

      if (Number(origin.saldo) < monto) {
        throw new HttpError(400, 'Saldo insuficiente para realizar la operación.');
      }

      if (cuenta_destino_id && cuenta_destino_id === cuenta_origen_id) {
        throw new HttpError(400, 'La cuenta de destino no puede ser la misma que la cuenta de origen.');
      }

      const accountTypeResult = await client.query(
        'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
        [origin.tipo_cuenta_id]
      );

      const transferLimit = accountTypeResult.rows[0]?.limite_transferencia;
      if (transferLimit !== null && transferLimit !== undefined && monto > Number(transferLimit)) {
        throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
      }

      let destination = null;
      let externalRecipient = null;
      let effectiveCbuDestino = null;
      let centralTransactionId = null;
      let canal = 'local';

      if (cuenta_destino_id) {
        const destinationResult = await client.query(
          'SELECT * FROM cuentas WHERE id = $1 FOR UPDATE',
          [cuenta_destino_id]
        );

        if (destinationResult.rowCount === 0) {
          throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
        }

        destination = destinationResult.rows[0];
        if (!destination.activa) {
          throw new HttpError(400, 'La cuenta de destino no está activa.');
        }
      } else {
        if (!destinatario_id && !cbu_destino) {
          throw new HttpError(400, 'Debes seleccionar una cuenta destino o indicar un destinatario válido.');
        }

        if (destinatario_id) {
          const destinatarioResult = await client.query(
            `SELECT *
             FROM destinatarios
             WHERE id = $1
               AND ($2::boolean = TRUE OR persona_id = $3)
             LIMIT 1`,
            [destinatario_id, isInternalUser(req.currentUser), req.currentUser.persona_id]
          );

          if (destinatarioResult.rowCount === 0) {
            throw new HttpError(404, 'No existe el destinatario seleccionado.');
          }

          externalRecipient = destinatarioResult.rows[0];
        }

        effectiveCbuDestino = externalRecipient?.cbu_externo || cbu_destino;

        if (!effectiveCbuDestino) {
          throw new HttpError(400, 'No se pudo determinar el CBU de destino.');
        }

        if (effectiveCbuDestino === origin.cbu) {
          throw new HttpError(400, 'No puedes transferir a la misma cuenta de origen.');
        }

        const centralTransfer = await centralBankService.createTransaction({
          cbuOrigen: origin.cbu,
          cbuDestino: effectiveCbuDestino,
          importe: monto,
          saldoOrigen: Number(origin.saldo),
        });

        effectiveCbuDestino =
          centralBankService.extractCentralCbu(centralTransfer) || effectiveCbuDestino;
        centralTransactionId = centralBankService.extractCentralTransactionId(centralTransfer);
        canal = 'interbancaria_saliente';
      }

      await client.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [monto, cuenta_origen_id]);

      if (destination) {
        await client.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [monto, cuenta_destino_id]);
      }

      const created = await client.query(
        `INSERT INTO transacciones (
          tipo_transaccion_id,
          cuenta_origen_id,
          cuenta_destino_id,
          monto,
          descripcion,
          estado,
          central_transaction_id,
          canal,
          cbu_origen,
          cbu_destino
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          tipo_transaccion_id,
          cuenta_origen_id,
          cuenta_destino_id,
          monto,
          descripcion,
          estado,
          centralTransactionId,
          canal,
          origin.cbu,
          destination?.cbu || effectiveCbuDestino,
        ]
      );

      await writeAuditLog(client, {
        usuarioId: req.currentUser?.id,
        accion: 'CREATE',
        entidad: 'transacciones',
        entidadId: created.rows[0].id,
        payloadDespues: created.rows[0],
        ipAddress: req.ip || null,
      });

      await client.query('COMMIT');
      res.status(201).json(created.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })
);

module.exports = router;
