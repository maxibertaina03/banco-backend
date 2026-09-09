const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const createCrudRouter = require('./crud-router');
const entities = require('./entities');
const { uuidLike } = require('../utils/schemas');

const router = createCrudRouter(entities.transacciones);

const esquemaDeTransferencia = z.object({
  tipo_transaccion_id: uuidLike,
  cuenta_origen_id: uuidLike,
  cuenta_destino_id: uuidLike.nullable().optional(),
  monto: z.coerce.number().positive(),
  descripcion: z.string().trim().min(1).nullable().optional(),
  estado: z.enum(['pendiente', 'completada', 'rechazada']).optional(),
});

router.post(
  '/operar',
  validate(esquemaDeTransferencia),
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

      const resultadoDeOrigen = await client.query(
        'SELECT * FROM cuentas WHERE id = $1 FOR UPDATE',
        [cuenta_origen_id]
      );

      if (resultadoDeOrigen.rowCount === 0) {
        throw new HttpError(404, `No existe la cuenta de origen ${cuenta_origen_id}.`);
      }

      const origen = resultadoDeOrigen.rows[0];
      if (!origen.activa) {
        throw new HttpError(400, 'La cuenta de origen no está activa.');
      }

      if (Number(origen.saldo) < monto) {
        throw new HttpError(400, 'Saldo insuficiente para realizar la operación.');
      }

      if (cuenta_destino_id && cuenta_destino_id === cuenta_origen_id) {
        throw new HttpError(400, 'La cuenta de destino no puede ser la misma que la cuenta de origen.');
      }

      let destino = null;

      if (cuenta_destino_id) {
        const resultadoDeDestino = await client.query(
          'SELECT * FROM cuentas WHERE id = $1 FOR UPDATE',
          [cuenta_destino_id]
        );

        if (resultadoDeDestino.rowCount === 0) {
          throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
        }

        destino = resultadoDeDestino.rows[0];
        if (!destino.activa) {
          throw new HttpError(400, 'La cuenta de destino no está activa.');
        }

        const resultadoDelTipoDeCuenta = await client.query(
          'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
          [origen.tipo_cuenta_id]
        );

        const limiteDeTransferencia = resultadoDelTipoDeCuenta.rows[0]?.limite_transferencia;
        if (limiteDeTransferencia !== null && limiteDeTransferencia !== undefined && monto > Number(limiteDeTransferencia)) {
          throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
        }
      }

      await client.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [monto, cuenta_origen_id]);

      if (destino) {
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
