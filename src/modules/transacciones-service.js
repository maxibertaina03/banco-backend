// Service de transacciones.
//
// Patrón: factory `createTransaccionesService({ pool, centralBankService,
// writeAuditLog })` que permite inyectar dependencias para testing. El
// `module.exports` por defecto es una instancia real, por lo que el resto
// del código (`require('./transacciones-service').listForUser(...)`) sigue
// funcionando sin cambios.
//
// En tests: `createTransaccionesService({ pool: mockPool, ... })` para
// reemplazar dependencias sin tocar el sistema de mocks de vitest.

const realPool = require('../db/pool');
const realCentralBankService = require('./central-bank-service');
const { writeAuditLog: realWriteAuditLog } = require('../utils/audit');
const HttpError = require('../utils/http-error');
const { isInternalUser } = require('../utils/access-control');
const { createTTLCache } = require('../utils/ttl-cache');
const q = require('./transacciones/transacciones-queries');
const { findStringInPayload, findFullNameInPayload } = require('./transacciones/transacciones-helpers');

function createTransaccionesService({
  pool = realPool,
  centralBankService = realCentralBankService,
  writeAuditLog = realWriteAuditLog,
  resolverCacheTtlMs = 60_000,
  resolverCacheMaxEntries = 500,
} = {}) {
  // TTL cache para resolveRecipient — evita pegarle a Brocoly en cada
  // keystroke. La cache vive en el closure de esta instancia, así cada test
  // puede tener su propia cache aislada.
  const resolverCache = createTTLCache(resolverCacheMaxEntries, resolverCacheTtlMs);

  // ── Helpers internos (orquestan queries + reglas de negocio) ───────────────

  async function getTransferTypeId(client) {
    const result = await q.selectTransferTypeId(client);
    if (result.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de transacción "transferencia".');
    }
    return result.rows[0].id;
  }

  // Cargas con FOR UPDATE: bloquean la fila durante la transacción para
  // evitar carreras saldo↔transferencia concurrente.
  async function getLocalAccountById(client, accountId) {
    const result = await q.selectAccountByIdForUpdate(client, accountId);
    return result.rows[0] || null;
  }

  async function getLocalAccountByCbu(client, cbu) {
    const result = await q.selectAccountByCbuForUpdate(client, cbu);
    return result.rows[0] || null;
  }

  async function validateTransferLimit(client, account, amount) {
    const accountTypeResult = await q.selectAccountTransferLimit(client, account.tipo_cuenta_id);
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

    let localDestination = destination.localAccountId
      ? await getLocalAccountById(client, destination.localAccountId)
      : await getLocalAccountByCbu(client, destination.cbu);

    if (localDestination && !localDestination.activa) {
      throw new HttpError(400, 'La cuenta de destino no está activa.');
    }

    let effectiveDestinationCbu = destination.cbu;
    let centralTransactionId = null;
    let finalEstado = 'completada';
    let centralTransfer = null;

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
    } catch (error) {
      // Duck typing en vez de `instanceof HttpError`: el service también
      // procesa errores con la misma forma en tests aunque la clase venga
      // de otro módulo. El status 422 ya identifica el caso "saldo
      // insuficiente" sin ambigüedad.
      if (error?.status !== 422) throw error;

      centralTransfer = error.details?.centralBank || null;
      centralTransactionId = centralBankService.extractCentralTransactionId(centralTransfer);
      effectiveDestinationCbu =
        centralBankService.extractCentralCbu(centralTransfer) || effectiveDestinationCbu;
      finalEstado = 'rechazada';
    }

    const canal = localDestination ? 'local' : 'interbancaria_saliente';

    if (finalEstado === 'completada') {
      await q.debitAccount(client, amount, origin.id);
      if (localDestination) {
        await q.creditAccount(client, amount, localDestination.id);
      }
    }

    const created = await q.insertTransferTransaction(client, [
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
    ]);

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

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ── API pública ───────────────────────────────────────────────────────────

  async function listForUser(currentUser) {
    if (isInternalUser(currentUser)) {
      const result = await q.selectAllTransactions(pool);
      return result.rows;
    }

    const result = await q.selectTransactionsForPersona(pool, currentUser.persona_id);
    return result.rows;
  }

  async function getByIdForUser(id, currentUser) {
    const result = isInternalUser(currentUser)
      ? await q.selectTransactionById(pool, id)
      : await q.selectTransactionByIdForPersona(pool, id, currentUser.persona_id);

    if (result.rowCount === 0) {
      throw new HttpError(404, `No existe la transacción con id ${id}.`);
    }
    return result.rows[0];
  }

  async function resolveRecipient({ alias, cbu }) {
    const normalizedAlias = typeof alias === 'string' ? alias.trim() : null;
    const normalizedCbu = typeof cbu === 'string' ? cbu.trim() : null;
    const cacheKey = normalizedAlias ? `alias:${normalizedAlias}` : `cbu:${normalizedCbu}`;

    const cached = resolverCache.get(cacheKey);
    if (cached) return cached;

    const centralData = normalizedAlias
      ? await centralBankService.findPersonByAlias(normalizedAlias)
      : await centralBankService.findPersonByCbu(normalizedCbu);

    const response = {
      alias: findStringInPayload(centralData, ['alias']) || normalizedAlias || null,
      cbu: centralBankService.extractCentralCbu(centralData) || normalizedCbu || null,
      titular: findFullNameInPayload(centralData),
      banco: findStringInPayload(centralData, ['bankName', 'bank_name', 'banco', 'nombreBanco']),
      raw: centralData,
    };

    resolverCache.set(cacheKey, response);
    return response;
  }

  async function createContractTransfer({
    cbuOrigen,
    cbuDestino,
    importe,
    saldoOrigen,
    currentUser,
    ipAddress,
  }) {
    return withTransaction(async (client) => {
      const origin = await getLocalAccountByCbu(client, cbuOrigen);
      if (!origin) {
        throw new HttpError(404, 'CBU origen no encontrado en el sistema.');
      }

      const transferTypeId = await getTransferTypeId(client);

      return persistCentralTransfer({
        client,
        currentUser,
        ipAddress,
        origin,
        destination: { cbu: cbuDestino },
        amount: importe,
        description: 'Transferencia realizada con contrato Banco Central',
        requestedSourceBalance: saldoOrigen,
        transferTypeId,
      });
    });
  }

  async function operate({
    tipo_transaccion_id,
    cuenta_origen_id,
    cuenta_destino_id = null,
    destinatario_id = null,
    cbu_destino = null,
    monto,
    descripcion = null,
    currentUser,
    ipAddress,
  }) {
    if (cuenta_destino_id && cuenta_destino_id === cuenta_origen_id) {
      throw new HttpError(400, 'La cuenta de destino no puede ser la misma que la cuenta de origen.');
    }

    return withTransaction(async (client) => {
      const origin = await getLocalAccountById(client, cuenta_origen_id);
      if (!origin) {
        throw new HttpError(404, `No existe la cuenta de origen ${cuenta_origen_id}.`);
      }

      let destination = null;
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

        let externalRecipient = null;
        if (destinatario_id) {
          const destinatarioResult = await q.selectDestinatario(
            client,
            destinatario_id,
            isInternalUser(currentUser),
            currentUser.persona_id
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

      return persistCentralTransfer({
        client,
        currentUser,
        ipAddress,
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
    });
  }

  // Helper paralelo a getTransferTypeId pero para depósitos. Cacheable porque
  // los tipos no cambian, pero por simplicidad lo dejamos como query.
  async function getDepositTypeId(client) {
    const result = await q.selectDepositTypeId(client);
    if (result.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de transacción "deposito".');
    }
    return result.rows[0].id;
  }

  // Depósito en efectivo a una cuenta. Operación interna (admin/operador/
  // tesorería) — simula que el cliente fue a una sucursal y depositó.
  // - No tiene cuenta de origen (efectivo físico → null).
  // - Acredita el monto inmediatamente.
  // - Convención semántica: cuenta_destino_id = cuenta receptora (para que
  //   el frontend la muestre como movimiento entrante con `+monto`).
  // - Sin paso por Banco Central (es operación interna del banco).
  async function createDeposit({
    cuenta_destino_id,
    monto,
    descripcion = null,
    currentUser,
    ipAddress,
  }) {
    if (!Number.isFinite(Number(monto)) || Number(monto) <= 0) {
      throw new HttpError(400, 'El monto del depósito debe ser mayor a cero.');
    }

    return withTransaction(async (client) => {
      const destination = await getLocalAccountById(client, cuenta_destino_id);
      if (!destination) {
        throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
      }
      if (!destination.activa) {
        throw new HttpError(400, 'La cuenta de destino no está activa.');
      }

      const transferTypeId = await getDepositTypeId(client);
      const amount = Number(monto);

      // Acreditar saldo.
      await q.creditAccount(client, amount, destination.id);

      // Registrar la transacción. cuenta_origen_id = NULL (efectivo físico).
      const created = await q.insertDepositTransaction(client, {
        transferTypeId,
        destinationId: destination.id,
        amount,
        descripcion,
        destinationCbu: destination.cbu,
      });

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
        destinationName: `${destination.nombre} ${destination.apellido}`.trim() || null,
        destinationCbu: destination.cbu,
      };
    });
  }

  async function syncIncomingForUser(currentUser) {
    if (!currentUser?.persona_id) {
      throw new HttpError(400, 'No se pudo determinar la persona asociada a tu usuario.');
    }

    const cbuResult = await q.selectActiveCbusForPersona(pool, currentUser.persona_id);
    const personaCbus = cbuResult.rows.map((r) => r.cbu);

    if (personaCbus.length === 0) {
      return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
    }

    return centralBankService.syncIncomingTransactions({
      minutes: 1440,
      personaCbus,
    });
  }

  return {
    listForUser,
    getByIdForUser,
    resolveRecipient,
    createContractTransfer,
    operate,
    createDeposit,
    syncIncomingForUser,
  };
}

// Instancia default usada por el router en producción.
const defaultService = createTransaccionesService();

module.exports = {
  ...defaultService,
  createTransaccionesService,
};
