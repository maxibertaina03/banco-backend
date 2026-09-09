// Service de transacciones.
//
// Patrón: factory `createTransaccionesService({ pool, centralBankService,
// escribirLogDeAuditoria })` que permite inyectar dependencias para testing. El
// `module.exports` por defecto es una instancia real, por lo que el resto
// del código (`require('./transacciones-service').listarParaUsuario(...)`) sigue
// funcionando sin cambios.
//
// En tests: `createTransaccionesService({ pool: mockPool, ... })` para
// reemplazar dependencias sin tocar el sistema de mocks de vitest.

const realPool = require('../db/pool');
const realCentralBankService = require('./central-bank-service');
const { escribirLogDeAuditoria: realWriteAuditLog } = require('../utils/audit');
const HttpError = require('../utils/http-error');
const { esUsuarioInterno } = require('../utils/access-control');
const { createTTLCache } = require('../utils/ttl-cache');
const { Dinero } = require('../utils/dinero');
const realMonedas = require('./monedas');
const q = require('./transacciones/transacciones-queries');
const { findStringInPayload, findFullNameInPayload } = require('./transacciones/transacciones-helpers');

function createTransaccionesService({
  monedas = realMonedas,
  pool = realPool,
  centralBankService = realCentralBankService,
  escribirLogDeAuditoria = realWriteAuditLog,
  resolverCacheTtlMs = 60_000,
  resolverCacheMaxEntries = 500,
} = {}) {
  // TTL cache para resolverDestinatario — evita pegarle a Brocoly en cada
  // keystroke. La cache vive en el closure de esta instancia, así cada test
  // puede tener su propia cache aislada.
  const resolverCache = createTTLCache(resolverCacheMaxEntries, resolverCacheTtlMs);

  // ── Helpers internos (orquestan queries + reglas de negocio) ───────────────

  async function obtenerIdTipoTransferencia(client) {
    const result = await q.seleccionarIdTipoTransferencia(client);
    if (result.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de transacción "transferencia".');
    }
    return result.rows[0].id;
  }

  // Cargas con FOR UPDATE: bloquean la fila durante la transacción para
  // evitar carreras saldo↔transferencia concurrente.
  async function obtenerCuentaLocalPorId(client, idCuenta) {
    const result = await q.seleccionarCuentaPorIdParaActualizar(client, idCuenta);
    return result.rows[0] || null;
  }

  async function obtenerCuentaLocalPorCbu(client, cbu) {
    const result = await q.seleccionarCuentaPorCbuParaActualizar(client, cbu);
    return result.rows[0] || null;
  }

  async function validarLimiteDeTransferencia(client, cuenta, amount) {
    const resultadoTipoDeCuenta = await q.seleccionarLimiteDeTransferencia(client, cuenta.tipo_cuenta_id);
    const transferLimit = resultadoTipoDeCuenta.rows[0]?.limite_transferencia;
    const limite = Dinero.desdeOpcional(transferLimit);
    if (limite !== null && Dinero.desde(amount).mayorQue(limite)) {
      throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
    }
  }

  async function guardarTransferenciaCentral({
    client,
    usuarioActual,
    ipAddress,
    origin,
    destination,
    amount,
    description,
    requestedSourceBalance,
    idTipoTransferencia,
  }) {
    // El router valida con `z.coerce.number()`, así que `amount` llega como
    // float. Se normaliza acá, una sola vez, para los dos callers: a partir de
    // este punto el importe viaja como decimal exacto y sólo se convierte a
    // número en el borde del Banco Central.
    let importeExacto;
    try {
      importeExacto = Dinero.desde(amount).redondeado();
    } catch {
      throw new HttpError(400, 'El importe de la transferencia no es válido.');
    }
    if (!importeExacto.esPositivo()) {
      throw new HttpError(400, 'El importe de la transferencia debe ser mayor a cero.');
    }

    if (!origin) {
      throw new HttpError(404, 'No se encontró la cuenta de origen.');
    }
    if (!origin.activa) {
      throw new HttpError(400, 'La cuenta de origen no está activa.');
    }
    if (!esUsuarioInterno(usuarioActual) && origin.persona_id !== usuarioActual.persona_id) {
      throw new HttpError(403, 'No puedes operar sobre una cuenta que no te pertenece.');
    }
    if (origin.cbu === destination.cbu) {
      throw new HttpError(400, 'El CBU origen no puede ser igual al CBU destino.');
    }

    // El Banco Central no valida monedas: su POST /transactions no tiene campo
    // `moneda` y movería el importe tal cual entre una caja en pesos y una en
    // dólares. La validación es nuestra. Va antes de tocar saldos y antes de
    // llamar al Central, para que una transferencia inválida no llegue a existir.
    await monedas.validarMonedasCompatibles(origin.moneda, destination.cbu, undefined);

    await validarLimiteDeTransferencia(client, origin, importeExacto);

    // Igualdad exacta: `origin.saldo` llega como string NUMERIC desde Postgres
    // y `Dinero` lo compara sin convertir a float, así que ya no hace falta la
    // tolerancia de 0.001 que antes tapaba el error de representación.
    if (requestedSourceBalance !== null && !Dinero.desde(requestedSourceBalance).igualA(origin.saldo)) {
      throw new HttpError(400, 'El saldoOrigen no coincide con el saldo actual de la cuenta de origen.');
    }

    let localDestination = destination.idCuentaLocal
      ? await obtenerCuentaLocalPorId(client, destination.idCuentaLocal)
      : await obtenerCuentaLocalPorCbu(client, destination.cbu);

    if (localDestination && !localDestination.activa) {
      throw new HttpError(400, 'La cuenta de destino no está activa.');
    }

    let effectiveDestinationCbu = destination.cbu;
    let idTransaccionCentral = null;
    let finalEstado = 'completada';
    let transferenciaDelCentral = null;

    try {
      const centralResponse = await centralBankService.crearTransaccion(
        {
          cbuOrigen: origin.cbu,
          cbuDestino: effectiveDestinationCbu,
          // El contrato del Banco Central exige números JSON, así que este es
          // el único punto donde se sale de decimal exacto — y es de salida.
          importe: importeExacto.aNumero(),
          saldoOrigen: Dinero.desde(origin.saldo).aNumero(),
        },
        undefined,
        { includeResponseMeta: true }
      );

      transferenciaDelCentral = centralResponse.data;
      idTransaccionCentral = centralBankService.extraerIdTransaccionCentral(transferenciaDelCentral);
      effectiveDestinationCbu =
        centralBankService.extractCentralCbu(transferenciaDelCentral) || effectiveDestinationCbu;
    } catch (error) {
      // Duck typing en vez de `instanceof HttpError`: el service también
      // procesa errores con la misma forma en tests aunque la clase venga
      // de otro módulo. El status 422 ya identifica el caso "saldo
      // insuficiente" sin ambigüedad.
      if (error?.status !== 422) throw error;

      transferenciaDelCentral = error.details?.centralBank || null;
      idTransaccionCentral = centralBankService.extraerIdTransaccionCentral(transferenciaDelCentral);
      effectiveDestinationCbu =
        centralBankService.extractCentralCbu(transferenciaDelCentral) || effectiveDestinationCbu;
      finalEstado = 'rechazada';
    }

    const canal = localDestination ? 'local' : 'interbancaria_saliente';

    if (finalEstado === 'completada') {
      await q.debitarDeCuenta(client, importeExacto.aString(), origin.id);
      if (localDestination) {
        await q.acreditarEnCuenta(client, importeExacto.aString(), localDestination.id);
      }
    }

    const created = await q.insertarTransaccionDeTransferencia(client, [
      idTipoTransferencia,
      origin.id,
      localDestination?.id || null,
      importeExacto.aString(),
      description,
      finalEstado,
      idTransaccionCentral,
      canal,
      origin.cbu,
      localDestination?.cbu || effectiveDestinationCbu,
    ]);

    await escribirLogDeAuditoria(client, {
      usuarioId: usuarioActual?.id,
      accion: 'CREATE',
      entidad: 'transacciones',
      entidadId: created.rows[0].id,
      payloadDespues: created.rows[0],
      ipAddress,
    });

    return {
      transaccion: created.rows[0],
      central: transferenciaDelCentral,
      statusCode: finalEstado === 'rechazada' ? 422 : 201,
      stateLabel: finalEstado === 'rechazada' ? 'rechazada' : 'aprobada',
      originName: `${origin.nombre} ${origin.apellido}`.trim() || null,
      destinationName:
        findFullNameInPayload(transferenciaDelCentral) ||
        (localDestination ? `${localDestination.nombre} ${localDestination.apellido}`.trim() : null),
      effectiveDestinationCbu,
    };
  }

  async function enTransaccionDeBd(fn) {
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

  async function listarParaUsuario(usuarioActual) {
    if (esUsuarioInterno(usuarioActual)) {
      const result = await q.selectAllTransactions(pool);
      return result.rows;
    }

    const result = await q.seleccionarTransaccionesDePersona(pool, usuarioActual.persona_id);
    return result.rows;
  }

  async function obtenerPorIdParaUsuario(id, usuarioActual) {
    const result = esUsuarioInterno(usuarioActual)
      ? await q.selectTransactionById(pool, id)
      : await q.seleccionarTransaccionDePersonaPorId(pool, id, usuarioActual.persona_id);

    if (result.rowCount === 0) {
      throw new HttpError(404, `No existe la transacción con id ${id}.`);
    }
    return result.rows[0];
  }

  async function resolverDestinatario({ alias, cbu }) {
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

  async function crearTransferenciaPorContrato({
    cbuOrigen,
    cbuDestino,
    importe,
    saldoOrigen,
    usuarioActual,
    ipAddress,
  }) {
    return enTransaccionDeBd(async (client) => {
      const origin = await obtenerCuentaLocalPorCbu(client, cbuOrigen);
      if (!origin) {
        throw new HttpError(404, 'CBU origen no encontrado en el sistema.');
      }

      const idTipoTransferencia = await obtenerIdTipoTransferencia(client);

      return guardarTransferenciaCentral({
        client,
        usuarioActual,
        ipAddress,
        origin,
        destination: { cbu: cbuDestino },
        amount: importe,
        description: 'Transferencia realizada con contrato Banco Central',
        requestedSourceBalance: saldoOrigen,
        idTipoTransferencia,
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
    usuarioActual,
    ipAddress,
  }) {
    if (cuenta_destino_id && cuenta_destino_id === cuenta_origen_id) {
      throw new HttpError(400, 'La cuenta de destino no puede ser la misma que la cuenta de origen.');
    }

    return enTransaccionDeBd(async (client) => {
      const origin = await obtenerCuentaLocalPorId(client, cuenta_origen_id);
      if (!origin) {
        throw new HttpError(404, `No existe la cuenta de origen ${cuenta_origen_id}.`);
      }

      let destination = null;
      let effectiveCbuDestino = null;

      if (cuenta_destino_id) {
        destination = await obtenerCuentaLocalPorId(client, cuenta_destino_id);
        if (!destination) {
          throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
        }
      } else {
        if (!destinatario_id && !cbu_destino) {
          throw new HttpError(400, 'Debes seleccionar una cuenta destino o indicar un destinatario válido.');
        }

        let destinatarioExterno = null;
        if (destinatario_id) {
          const destinatarioResult = await q.selectDestinatario(
            client,
            destinatario_id,
            esUsuarioInterno(usuarioActual),
            usuarioActual.persona_id
          );

          if (destinatarioResult.rowCount === 0) {
            throw new HttpError(404, 'No existe el destinatario seleccionado.');
          }
          destinatarioExterno = destinatarioResult.rows[0];
        }

        effectiveCbuDestino = destinatarioExterno?.cbu_externo || cbu_destino;
        if (!effectiveCbuDestino) {
          throw new HttpError(400, 'No se pudo determinar el CBU de destino.');
        }
      }

      if (!destination && effectiveCbuDestino) {
        destination = await obtenerCuentaLocalPorCbu(client, effectiveCbuDestino);
      }

      effectiveCbuDestino = destination?.cbu || effectiveCbuDestino;
      if (!effectiveCbuDestino) {
        throw new HttpError(400, 'No se pudo determinar el CBU de destino.');
      }
      if (effectiveCbuDestino === origin.cbu) {
        throw new HttpError(400, 'No puedes transferir a la misma cuenta de origen.');
      }

      return guardarTransferenciaCentral({
        client,
        usuarioActual,
        ipAddress,
        origin,
        destination: {
          cbu: effectiveCbuDestino,
          idCuentaLocal: destination?.id || null,
        },
        amount: monto,
        description: descripcion,
        requestedSourceBalance: null,
        idTipoTransferencia: tipo_transaccion_id,
      });
    });
  }

  // Helper paralelo a obtenerIdTipoTransferencia pero para depósitos. Cacheable porque
  // los tipos no cambian, pero por simplicidad lo dejamos como query.
  async function obtenerIdTipoDeposito(client) {
    const result = await q.seleccionarIdTipoDeposito(client);
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
  async function crearDeposito({
    cuenta_destino_id,
    monto,
    descripcion = null,
    usuarioActual,
    ipAddress,
  }) {
    let montoDeposito;
    try {
      montoDeposito = Dinero.desde(monto).redondeado();
    } catch {
      throw new HttpError(400, 'El monto del depósito no es un importe válido.');
    }
    if (!montoDeposito.esPositivo()) {
      throw new HttpError(400, 'El monto del depósito debe ser mayor a cero.');
    }

    return enTransaccionDeBd(async (client) => {
      const destination = await obtenerCuentaLocalPorId(client, cuenta_destino_id);
      if (!destination) {
        throw new HttpError(404, `No existe la cuenta de destino ${cuenta_destino_id}.`);
      }
      if (!destination.activa) {
        throw new HttpError(400, 'La cuenta de destino no está activa.');
      }

      const idTipoDeposito = await obtenerIdTipoDeposito(client);
      const amount = montoDeposito.aString();

      // Acreditar saldo.
      await q.acreditarEnCuenta(client, amount, destination.id);

      // Registrar la transacción. cuenta_origen_id = NULL (efectivo físico).
      const created = await q.insertarTransaccionDeDeposito(client, {
        idTipoDeposito,
        destinationId: destination.id,
        amount,
        descripcion,
        destinationCbu: destination.cbu,
      });

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'transacciones',
        entidadId: created.rows[0].id,
        payloadDespues: created.rows[0],
        ipAddress,
      });

      return {
        transaccion: created.rows[0],
        destinationName: `${destination.nombre} ${destination.apellido}`.trim() || null,
        destinationCbu: destination.cbu,
      };
    });
  }

  async function syncIncomingForUser(usuarioActual) {
    if (!usuarioActual?.persona_id) {
      throw new HttpError(400, 'No se pudo determinar la persona asociada a tu usuario.');
    }

    const cbuResult = await q.selectActiveCbusForPersona(pool, usuarioActual.persona_id);
    const personaCbus = cbuResult.rows.map((r) => r.cbu);

    if (personaCbus.length === 0) {
      return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
    }

    return centralBankService.sincronizarTransaccionesEntrantes({
      minutes: 1440,
      personaCbus,
    });
  }

  return {
    listarParaUsuario,
    obtenerPorIdParaUsuario,
    resolverDestinatario,
    crearTransferenciaPorContrato,
    operate,
    crearDeposito,
    syncIncomingForUser,
  };
}

// Instancia default usada por el router en producción.
const defaultService = createTransaccionesService();

module.exports = {
  ...defaultService,
  createTransaccionesService,
};
