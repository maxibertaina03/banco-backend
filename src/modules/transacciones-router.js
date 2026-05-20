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

// TTL cache for /destinatario/resolver — avoids hitting Brocoly on every keystroke.
// 60 s is short enough to stay fresh but long enough to absorb repeated lookups.
const RESOLVER_CACHE_TTL = 60 * 1000;
const resolverCache = new Map(); // `alias:<v>` | `cbu:<v>` → { value, expiresAt }

function getResolverCached(key) {
  const entry = resolverCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  resolverCache.delete(key);
  return null;
}

function setResolverCached(key, value) {
  resolverCache.set(key, { value, expiresAt: Date.now() + RESOLVER_CACHE_TTL });
}

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
}).refine((data) => Boolean(data.cuenta_destino_id || data.destinatario_id || data.cbu_destino), {
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

async function getTransferTypeId(client) {
  const result = await client.query(
    "SELECT id FROM tipos_transaccion WHERE lower(nombre) = 'transferencia' LIMIT 1"
  );

  if (result.rowCount === 0) {
    throw new HttpError(500, 'No se encontró el tipo de transacción "transferencia".');
  }

  return result.rows[0].id;
}

async function getLocalAccountById(client, accountId) {
  const result = await client.query(
    `SELECT c.*, p.nombre, p.apellido
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     WHERE c.id = $1
     FOR UPDATE`,
    [accountId]
  );

  return result.rows[0] || null;
}

async function getLocalAccountByCbu(client, cbu) {
  const result = await client.query(
    `SELECT c.*, p.nombre, p.apellido
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     WHERE c.cbu = $1
     FOR UPDATE`,
    [cbu]
  );

  return result.rows[0] || null;
}

async function validateTransferLimit(client, account, amount) {
  const accountTypeResult = await client.query(
    'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
    [account.tipo_cuenta_id]
  );

  const transferLimit = accountTypeResult.rows[0]?.limite_transferencia;
  if (transferLimit !== null && transferLimit !== undefined && amount > Number(transferLimit)) {
    throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
  }
}

async function persistCentralTransfer({
  client,
  currentUser,
  ipAddress,
  origin,
  destination,
  amount,
  description,
  requestedSourceBalance,
  transferTypeId,
}) {
  if (!origin) {
    throw new HttpError(404, 'No se encontró la cuenta de origen.');
  }

  if (!origin.activa) {
    throw new HttpError(400, 'La cuenta de origen no está activa.');
  }

  if (!isInternalUser(currentUser) && origin.persona_id !== currentUser.persona_id) {
    throw new HttpError(403, 'No puedes operar sobre una cuenta que no te pertenece.');
  }

  if (origin.cbu === destination.cbu) {
    throw new HttpError(400, 'El CBU origen no puede ser igual al CBU destino.');
  }

  await validateTransferLimit(client, origin, amount);

  if (requestedSourceBalance !== null && Math.abs(Number(requestedSourceBalance) - Number(origin.saldo)) > 0.001) {
    throw new HttpError(400, 'El saldoOrigen no coincide con el saldo actual de la cuenta de origen.');
  }

  let localDestination = null;
  let effectiveDestinationCbu = destination.cbu;
  let centralTransactionId = null;
  let finalEstado = 'completada';
  let centralTransfer = null;

  if (destination.localAccountId) {
    localDestination = await getLocalAccountById(client, destination.localAccountId);
  } else {
    localDestination = await getLocalAccountByCbu(client, destination.cbu);
  }

  if (localDestination && !localDestination.activa) {
    throw new HttpError(400, 'La cuenta de destino no está activa.');
  }

  const canal = localDestination ? 'local' : 'interbancaria_saliente';

  try {
    const centralResponse = await centralBankService.createTransaction(
      {
        cbuOrigen: origin.cbu,
        cbuDestino: effectiveDestinationCbu,
        importe: amount,
        saldoOrigen: Number(origin.saldo),
      },
      undefined,
      { includeResponseMeta: true }
    );

    centralTransfer = centralResponse.data;
    centralTransactionId = centralBankService.extractCentralTransactionId(centralTransfer);
    effectiveDestinationCbu =
      centralBankService.extractCentralCbu(centralTransfer) || effectiveDestinationCbu;
    finalEstado = 'completada';
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 422) {
      throw error;
    }

    centralTransfer = error.details?.centralBank || null;
    centralTransactionId = centralBankService.extractCentralTransactionId(centralTransfer);
    effectiveDestinationCbu =
      centralBankService.extractCentralCbu(centralTransfer) || effectiveDestinationCbu;
    finalEstado = 'rechazada';
  }

  if (finalEstado === 'completada') {
    await client.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [amount, origin.id]);

    if (localDestination) {
      await client.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [amount, localDestination.id]);
    }
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
      transferTypeId,
      origin.id,
      localDestination?.id || null,
      amount,
      description,
      finalEstado,
      centralTransactionId,
      canal,
      origin.cbu,
      localDestination?.cbu || effectiveDestinationCbu,
    ]
  );

  await writeAuditLog(client, {
    usuarioId: currentUser?.id,
    accion: 'CREATE',
    entidad: 'transacciones',
    entidadId: created.rows[0].id,
    payloadDespues: created.rows[0],
    ipAddress,
  });

  return {
    transaction: created.rows[0],
    central: centralTransfer,
    statusCode: finalEstado === 'rechazada' ? 422 : 201,
    stateLabel: finalEstado === 'rechazada' ? 'rechazada' : 'aprobada',
    originName: `${origin.nombre} ${origin.apellido}`.trim() || null,
    destinationName:
      findFullNameInPayload(centralTransfer) ||
      (localDestination ? `${localDestination.nombre} ${localDestination.apellido}`.trim() : null),
    effectiveDestinationCbu,
  };
}

router.get(
  '/destinatario/resolver',
  validate(resolveRecipientSchema, 'query'),
  asyncHandler(async (req, res) => {
    const alias = typeof req.query.alias === 'string' ? req.query.alias.trim() : null;
    const cbu = typeof req.query.cbu === 'string' ? req.query.cbu.trim() : null;
    const cacheKey = alias ? `alias:${alias}` : `cbu:${cbu}`;

    const cached = getResolverCached(cacheKey);
    if (cached) return res.json(cached);

    const centralData = alias
      ? await centralBankService.findPersonByAlias(alias)
      : await centralBankService.findPersonByCbu(cbu);

    const response = {
      alias: findStringInPayload(centralData, ['alias']) || alias || null,
      cbu: centralBankService.extractCentralCbu(centralData) || cbu || null,
      titular: findFullNameInPayload(centralData),
      banco: findStringInPayload(centralData, ['bankName', 'bank_name', 'banco', 'nombreBanco']),
      raw: centralData,
    };

    setResolverCached(cacheKey, response);
    res.json(response);
  })
);

router.post(
  '/',
  validate(centralContractTransferSchema),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();

    try {
      const { cbuOrigen, cbuDestino, importe, saldoOrigen } = req.body;

      await client.query('BEGIN');

      const origin = await getLocalAccountByCbu(client, cbuOrigen);
      if (!origin) {
        throw new HttpError(404, 'CBU origen no encontrado en el sistema.');
      }

      const destination = { cbu: cbuDestino };
      const transferTypeId = await getTransferTypeId(client);

      const result = await persistCentralTransfer({
        client,
        currentUser: req.currentUser,
        ipAddress: req.ip || null,
        origin,
        destination,
        amount: importe,
        description: 'Transferencia realizada con contrato Banco Central',
        requestedSourceBalance: saldoOrigen,
        transferTypeId,
      });

      await client.query('COMMIT');

      res.status(result.statusCode).json({
        message:
          result.stateLabel === 'aprobada'
            ? 'Transacción aprobada'
            : 'Saldo insuficiente. La transacción queda registrada como rechazada.',
        transactionId: result.central?.transactionId || result.transaction.central_transaction_id || result.transaction.id,
        estado: result.stateLabel,
        cbuOrigen,
        cbuDestino: result.effectiveDestinationCbu,
        importe,
        nombreOrigen: result.originName,
        nombreDestino: result.destinationName,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

      const origin = await getLocalAccountById(client, cuenta_origen_id);

      if (!origin) {
        throw new HttpError(404, `No existe la cuenta de origen ${cuenta_origen_id}.`);
      }

      if (cuenta_destino_id && cuenta_destino_id === cuenta_origen_id) {
        throw new HttpError(400, 'La cuenta de destino no puede ser la misma que la cuenta de origen.');
      }

      let destination = null;
      let externalRecipient = null;
      let effectiveCbuDestino = null;

      if (cuenta_destino_id) {
        destination = await getLocalAccountById(client, cuenta_destino_id);

        if (!destination) {
          throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
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
      }

      if (!destination && effectiveCbuDestino) {
        destination = await getLocalAccountByCbu(client, effectiveCbuDestino);
      }

      effectiveCbuDestino = destination?.cbu || effectiveCbuDestino;

      if (!effectiveCbuDestino) {
        throw new HttpError(400, 'No se pudo determinar el CBU de destino.');
      }

      if (effectiveCbuDestino === origin.cbu) {
        throw new HttpError(400, 'No puedes transferir a la misma cuenta de origen.');
      }

      const result = await persistCentralTransfer({
        client,
        currentUser: req.currentUser,
        ipAddress: req.ip || null,
        origin,
        destination: {
          cbu: effectiveCbuDestino,
          localAccountId: destination?.id || null,
        },
        amount: monto,
        description: descripcion,
        requestedSourceBalance: null,
        transferTypeId: tipo_transaccion_id,
      });

      await client.query('COMMIT');
      res.status(result.statusCode).json({
        ...result.transaction,
        central: result.central,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })
);

// Cualquier usuario autenticado puede sincronizar las transferencias entrantes de sus propias cuentas.
// El filtro por persona_id garantiza que solo se procesen sus CBUs.
router.post(
  '/sync-incoming',
  asyncHandler(async (req, res) => {
    const user = req.currentUser;

    if (!user?.persona_id) {
      throw new HttpError(400, 'No se pudo determinar la persona asociada a tu usuario.');
    }

    const cbuResult = await pool.query(
      'SELECT cbu FROM cuentas WHERE persona_id = $1 AND cbu IS NOT NULL AND activa = TRUE',
      [user.persona_id]
    );

    const personaCbus = cbuResult.rows.map((r) => r.cbu);

    if (personaCbus.length === 0) {
      return res.json({ processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] });
    }

    const result = await centralBankService.syncIncomingTransactions({
      minutes: 1440,
      personaCbus,
    });

    res.json(result);
  })
);

module.exports = router;
