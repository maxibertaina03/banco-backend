const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const { uuidLike } = require('../utils/schemas');
const { isInternalUser } = require('../utils/access-control');

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
  monto: z.coerce.number().positive(),
  descripcion: z.string().trim().min(1).nullable().optional(),
  estado: z.enum(['pendiente', 'completada', 'rechazada']).optional(),
});

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

      let destination = null;

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

        const accountTypeResult = await client.query(
          'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
          [origin.tipo_cuenta_id]
        );

        const transferLimit = accountTypeResult.rows[0]?.limite_transferencia;
        if (transferLimit !== null && transferLimit !== undefined && monto > Number(transferLimit)) {
          throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
        }
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
          estado
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [tipo_transaccion_id, cuenta_origen_id, cuenta_destino_id, monto, descripcion, estado]
      );

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
