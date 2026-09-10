const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { Dinero } = require('../utils/dinero');
const {
  getCentralBankConfig,
  getPublicCentralBankConfig,
  normalizeEnvironment,
  upsertCentralBankConfig,
} = require('./central-bank-config');
const {
  requestWithApiKey,
  requestWithRegisterToken,
} = require('./central-bank-client');
const { escribirLogDeAuditoria } = require('../utils/audit');
const { createTTLCache } = require('../utils/ttl-cache');
const {
  generarNumeroDeCuentaLocal,
  sanitizeCentralText,
  sanitizeDni,
  buildAliasCandidates,
  extractCentralCbu,
  extraerIdTransaccionCentral,
  extractCentralAlias,
  toSyncIssues,
} = require('./central-bank/central-bank-helpers');
const q = require('./central-bank/central-bank-queries');

const DEFAULT_SYNC_LIMIT = 25;
const DEFAULT_ACCOUNT_TYPE_NAME = 'Caja de Ahorro';

// Cache for listBanks — the bank list changes only when banks register/rename.
// Max 10 entries (one per environment variant), TTL 5 minutes.
const banksCache = createTTLCache(10, 5 * 60_000);

async function tryAssignAlias(cbu, candidates, environment) {
  const warnings = [];

  for (const candidate of candidates) {
    try {
      const response = await assignAlias(cbu, candidate, environment);
      return {
        assignedAlias: candidate,
        aliasResponse: response,
        warnings,
      };
    } catch (error) {
      if (error instanceof HttpError && (error.status === 409 || error.status === 400)) {
        warnings.push(`No se pudo asignar el alias "${candidate}": ${error.message}`);
        continue;
      }

      throw error;
    }
  }

  return {
    assignedAlias: null,
    aliasResponse: null,
    warnings,
  };
}

async function obtenerCuentaASincronizarPorId(idCuenta) {
  const result = await q.seleccionarCuentaASincronizarPorId(pool, idCuenta);
  return result.rows[0] || null;
}

async function registerBank({ name, environment }) {
  const config = await getCentralBankConfig(environment);
  const bankName = name || config.bank_name;

  if (!bankName) {
    throw new HttpError(400, 'Debes indicar el nombre del banco.');
  }

  const centralResponse = await requestWithRegisterToken('post', '/banks', {
    data: { name: bankName },
    environment,
  });

  const registry = await saveBankRegistration(centralResponse);

  return {
    ...centralResponse,
    registry,
  };
}

async function updateBankName({ name, environment }) {
  const centralResponse = await requestWithApiKey('put', '/banks/me', {
    data: { name },
    environment,
  });

  const effectiveEnvironment = normalizeEnvironment(environment);
  const config = await upsertCentralBankConfig({
    environment: effectiveEnvironment,
    bankName: name,
  });
  const registry = await q.updateBankRegistryName(pool, name, effectiveEnvironment);

  return {
    centralBank: centralResponse,
    config,
    registry: registry.rows[0] || null,
  };
}

async function listBanks(environment) {
  const env = normalizeEnvironment(environment);
  const cached = banksCache.get(env);
  if (cached) return cached;

  const result = await requestWithApiKey('get', '/banks', { environment });
  banksCache.set(env, result);
  return result;
}

async function getBankByCode(bankCode, environment) {
  return requestWithApiKey('get', `/banks/${encodeURIComponent(bankCode)}`, {
    environment,
  });
}

async function getLocalRegistration(environment) {
  const effectiveEnvironment = normalizeEnvironment(environment);
  const result = await q.selectLatestRegistration(pool, effectiveEnvironment);
  return result.rows[0] || null;
}

async function getConfig(environment) {
  return getPublicCentralBankConfig(environment);
}

async function saveConfig(payload) {
  return upsertCentralBankConfig(payload);
}

async function registerPerson(payload, environment, { includeResponseMeta = false } = {}) {
  return requestWithApiKey('post', '/persons', {
    data: payload,
    environment,
    includeResponseMeta,
  });
}

async function registrarPersonaLocalDesdeCentral(
  payload,
  auditContext = { usuarioId: null, ipAddress: null }
) {
  const environment = payload.environment;
  const sanitizedPayload = {
    nombre: sanitizeCentralText(payload.nombre),
    apellido: sanitizeCentralText(payload.apellido),
    dni: sanitizeDni(payload.dni),
  };

  if (!sanitizedPayload.nombre || !sanitizedPayload.apellido || !sanitizedPayload.dni) {
    throw new HttpError(400, 'Nombre, apellido y DNI son obligatorios para registrar la persona.');
  }

  const registrationResponse = await registerPerson(sanitizedPayload, environment, {
    includeResponseMeta: true,
  });

  const centralPerson = registrationResponse.data;
  const centralCbu = extractCentralCbu(centralPerson);
  const centralAlias = extractCentralAlias(centralPerson);

  if (!centralCbu) {
    throw new HttpError(502, 'El Banco Central no devolvió un CBU utilizable.', {
      centralBank: centralPerson,
    });
  }

  const email = payload.email?.trim().toLowerCase() || null;
  const telefono = payload.telefono?.trim() || null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let personaResult = await q.selectPersonaByDni(client, sanitizedPayload.dni);

    let persona;

    if (personaResult.rowCount > 0) {
      persona = (
        await q.updatePersonaIdentity(client, {
          nombre: sanitizedPayload.nombre,
          apellido: sanitizedPayload.apellido,
          email,
          telefono,
          id: personaResult.rows[0].id,
        })
      ).rows[0];
    } else {
      persona = (
        await q.insertPersonaFromCentral(client, {
          nombre: sanitizedPayload.nombre,
          apellido: sanitizedPayload.apellido,
          dni: sanitizedPayload.dni,
          email,
          telefono,
        })
      ).rows[0];
    }

    const roleResult = await q.selectClienteRoleId(client);

    if (roleResult.rowCount > 0) {
      await q.insertarRolDePersona(client, persona.id, roleResult.rows[0].id);
    }

    const resultadoTipoDeCuenta = await q.seleccionarTipoDeCuentaPorNombre(client, DEFAULT_ACCOUNT_TYPE_NAME);

    if (resultadoTipoDeCuenta.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de cuenta Caja de Ahorro.');
    }

    const cbuOwnerResult = await q.seleccionarTitularDeCuentaPorCbu(client, centralCbu);

    if (cbuOwnerResult.rowCount > 0 && cbuOwnerResult.rows[0].persona_id !== persona.id) {
      throw new HttpError(409, 'El CBU devuelto por Banco Central ya está asociado a otra persona local.');
    }

    let resultadoCuenta;

    if (cbuOwnerResult.rowCount > 0) {
      resultadoCuenta = await q.seleccionarCuentaPorId(client, cbuOwnerResult.rows[0].id);
    } else {
      resultadoCuenta = await q.seleccionarPrimeraCuentaDePersona(client, persona.id);
    }

    let cuenta;

    if (resultadoCuenta.rowCount > 0) {
      cuenta = (
        await q.vincularCuentaConCentral(client, {
          cbu: centralCbu,
          alias: centralAlias,
          id: resultadoCuenta.rows[0].id,
        })
      ).rows[0];
    } else {
      let cuentaCreada = null;
      let attempts = 0;

      while (!cuentaCreada && attempts < 5) {
        attempts += 1;

        try {
          cuentaCreada = (
            await q.insertarCuentaDesdeCentral(client, {
              personaId: persona.id,
              tipoCuentaId: resultadoTipoDeCuenta.rows[0].id,
              numeroCuenta: generarNumeroDeCuentaLocal(persona.id),
              cbu: centralCbu,
              alias: centralAlias,
            })
          ).rows[0];
        } catch (error) {
          if (error?.code === '23505') {
            continue;
          }

          throw error;
        }
      }

      if (!cuentaCreada) {
        throw new HttpError(500, 'No se pudo generar una cuenta local única para la persona.');
      }

      cuenta = cuentaCreada;
    }

    await escribirLogDeAuditoria(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'CREATE',
      entidad: 'personas',
      entidadId: persona.id,
      payloadDespues: {
        source: 'central-bank',
        centralStatus: registrationResponse.status,
        persona,
        cuenta: cuenta,
      },
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');

    return {
      status: registrationResponse.status === 200 ? 200 : 201,
      message:
        registrationResponse.status === 200
          ? 'La persona ya existía en tu banco dentro del Banco Central y se sincronizó la base local.'
          : 'Persona registrada en Banco Central y sincronizada en la base local.',
      centralBankStatus: registrationResponse.status,
      centralBankPerson: centralPerson,
      persona,
      cuenta: cuenta,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function findPersonByCbu(cbu, environment) {
  return requestWithApiKey('get', `/persons/${encodeURIComponent(cbu)}`, {
    environment,
  });
}

async function assignAlias(cbu, alias, environment) {
  const centralResponse = await requestWithApiKey('put', `/persons/${encodeURIComponent(cbu)}/alias`, {
    data: { alias },
    environment,
  });

  await q.actualizarAliasDeCuenta(pool, alias, cbu);

  return centralResponse;
}

async function findPersonByAlias(alias, environment) {
  return requestWithApiKey('get', `/persons/alias/${encodeURIComponent(alias)}`, {
    environment,
  });
}

async function crearTransaccion(payload, environment, { includeResponseMeta = false } = {}) {
  return requestWithApiKey('post', '/transactions', {
    data: payload,
    environment,
    includeResponseMeta,
  });
}

async function listarTransacciones({ environment, minutes } = {}) {
  return requestWithApiKey('get', '/transactions', {
    environment,
    params: minutes ? { minutos: minutes } : undefined,
  });
}

// ── Cuentas multi-moneda y central de deudores ──────────────────────────────
// Las seis rutas que el Banco Central publicó en agosto de 2026. Los nombres de
// ruta y de campo van en INGLÉS a propósito: son su contrato, no el nuestro
// (ver docs/GLOSARIO.md).
//
// Verificado contra el ambiente `test` el 8/9/2026; donde el comportamiento real
// difiere de su documentación, está anotado.

/**
 * Abre una caja de ahorro en el Banco Central y devuelve su CBU.
 *
 * Ojo con los códigos, porque no son los que uno espera:
 *  - `moneda: 'USD'` la primera vez → 201 con CBU nuevo.
 *  - `moneda: 'USD'` repetido → 200 con la cuenta existente. Es idempotente, y
 *    es el ÚNICO modo de recuperar el CBU si lo perdimos: no hay endpoint que
 *    liste las cuentas de una persona.
 *  - `moneda: 'ARS'` → siempre 200. La caja en pesos nace con `POST /persons`,
 *    así que este endpoint nunca la crea.
 */
async function abrirCuentaCentral({ dni, moneda, environment } = {}) {
  return requestWithApiKey('post', '/accounts', {
    data: { dni, moneda },
    environment,
    includeResponseMeta: true,
  });
}

/**
 * Resuelve un CBU cualquiera: devuelve titular, banco, moneda y saldo.
 *
 * La documentación del Central dice que sólo encuentra cuentas en monedas
 * distintas de ARS. **Es falso**: probado contra `test`, resuelve las dos y
 * siempre trae `moneda`. Por eso este es el único endpoint que hace falta para
 * saber de qué moneda es un CBU, y no hace falta el fallback a `/persons/{cbu}`
 * que estaba planeado.
 */
async function buscarCuentaPorCbu(cbu, environment) {
  return requestWithApiKey('get', `/accounts/${encodeURIComponent(cbu)}`, { environment });
}

/** Busca una cuenta por su alias. El alias es único en todo el sistema. */
async function buscarCuentaPorAlias(alias, environment) {
  return requestWithApiKey('get', `/accounts/alias/${encodeURIComponent(alias)}`, { environment });
}

/** Asigna o cambia el alias de una cuenta. Cada cuenta tiene el suyo. */
async function asignarAliasDeCuenta(cbu, alias, environment) {
  return requestWithApiKey('put', `/accounts/${encodeURIComponent(cbu)}/alias`, {
    data: { alias },
    environment,
  });
}

/**
 * Informa al Banco Central la deuda de un titular con NUESTRO banco.
 *
 * Es lo que hace que la central de deudores sirva: la consulta junta lo que
 * informó cada banco, así que si no informamos, nuestros préstamos no existen
 * para el resto del sistema.
 *
 * Hay un solo informe activo por DNI: volver a llamar actualiza monto y
 * situación en vez de duplicar (201 la primera vez, 200 las siguientes). La
 * `entidad` la pone el Central a partir de nuestra API key, no se puede informar
 * en nombre de otro.
 */
async function informarDeuda({ dni, monto, situacion, environment } = {}) {
  return requestWithApiKey('post', '/central-deudores', {
    data: { dni, monto, situacion },
    environment,
    includeResponseMeta: true,
  });
}

/**
 * Situación crediticia consolidada de un titular, sumando lo que informó cada
 * banco. La `situacion` que devuelve es la PEOR de todas sus deudas.
 *
 * Su documentación dice que devuelve 404 si el DNI no figura. **No es así**:
 * probado contra `test`, para un DNI sin deudas contesta 200 con
 * `situacion: 1` y `deudas: []`. O sea que no se puede distinguir "no existe"
 * de "está al día", pero da igual porque la decisión se toma sobre `situacion`.
 */
async function consultarSituacionCrediticia(dni, environment) {
  return requestWithApiKey('get', `/central-deudores/${encodeURIComponent(dni)}`, { environment });
}

async function listarCuentasASincronizar({ environment, limit = DEFAULT_SYNC_LIMIT } = {}) {
  normalizeEnvironment(environment);

  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(Number(limit), 200))
    : DEFAULT_SYNC_LIMIT;

  const result = await q.seleccionarCuentasASincronizar(pool, safeLimit);

  return result.rows.map((cuenta) => {
    const issues = toSyncIssues(cuenta);
    return {
      ...cuenta,
      sync_ready: issues.length === 0,
      sync_issues: issues,
      suggested_alias: buildAliasCandidates(cuenta, 'orbital')[0] || null,
    };
  });
}

async function sincronizarCuenta(idCuenta, environment) {
  const config = await getCentralBankConfig(environment);
  const cuenta = await obtenerCuentaASincronizarPorId(idCuenta);

  if (!cuenta) {
    throw new HttpError(404, 'No se encontró la cuenta indicada.');
  }

  const issues = toSyncIssues(cuenta);

  if (issues.length > 0) {
    throw new HttpError(400, `La cuenta no está lista para sincronizar. ${issues.join(' ')}`);
  }

  const payload = {
    nombre: sanitizeCentralText(cuenta.nombre),
    apellido: sanitizeCentralText(cuenta.apellido),
    dni: sanitizeDni(cuenta.dni),
  };

  let registrationResponse;

  try {
    registrationResponse = await registerPerson(payload, environment, {
      includeResponseMeta: true,
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      throw new HttpError(400, error.message, {
        ...error.details,
        syncPayload: payload,
      });
    }

    throw error;
  }

  const registrationStatus = registrationResponse.status;
  const registration = registrationResponse.data;
  const centralCbu = extractCentralCbu(registration);
  const existingAlias = extractCentralAlias(registration);

  if (!centralCbu) {
    throw new HttpError(
      502,
      'El Banco Central no devolvió un CBU utilizable para la persona registrada.',
      { centralBank: registration }
    );
  }

  let aliasAttempt = {
    assignedAlias: existingAlias,
    aliasResponse: null,
    warnings: [],
  };

  if (registrationStatus !== 200) {
    const aliasCandidates = buildAliasCandidates(cuenta, config.bank_name);
    aliasAttempt = await tryAssignAlias(centralCbu, aliasCandidates, environment);
  }

  const cuentaActualizada = await q.resultadoSincronizacionCuenta(pool, {
    cbu: centralCbu,
    alias: aliasAttempt.assignedAlias,
    idCuenta,
  });

  const warnings = [...aliasAttempt.warnings];

  if (registrationStatus === 200) {
    warnings.push(
      'La persona ya estaba registrada en este banco dentro del Banco Central y se reutilizaron sus datos para sincronizar la cuenta local.'
    );
  } else if (!aliasAttempt.assignedAlias) {
    warnings.push(
      'La cuenta quedó registrada en el banco central, pero no se pudo asignar un alias automáticamente.'
    );
  }

  if (centralCbu !== cuenta.cbu) {
    warnings.push(
      `El CBU local se actualizó desde ${cuenta.cbu} a ${centralCbu} para mantener consistencia con el Banco Central.`
    );
  }

  return {
    cuenta: {
      ...cuentaActualizada.rows[0],
      tipo_cuenta_nombre: cuenta.tipo_cuenta_nombre,
      nombre: cuenta.nombre,
      apellido: cuenta.apellido,
      dni: cuenta.dni,
      email: cuenta.email,
    },
    persona: {
      id: cuenta.persona_id,
      nombre: cuenta.nombre,
      apellido: cuenta.apellido,
      dni: cuenta.dni,
      email: cuenta.email,
    },
    centralBank: {
      status: registrationStatus,
      registration,
      alias: aliasAttempt.aliasResponse,
      cbu: centralCbu,
    },
    warnings,
  };
}

async function sincronizarCuentas({ environment, idsCuenta, limit = DEFAULT_SYNC_LIMIT } = {}) {
  const cuentas = Array.isArray(idsCuenta) && idsCuenta.length > 0
    ? await Promise.all(idsCuenta.map((idCuenta) => obtenerCuentaASincronizarPorId(idCuenta)))
    : await listarCuentasASincronizar({ environment, limit });

  const cuentasFiltradas = cuentas.filter(Boolean);
  const results = [];

  for (const cuenta of cuentasFiltradas) {
    try {
      const result = await sincronizarCuenta(cuenta.id, environment);
      results.push({
        idCuenta: cuenta.id,
        status: 'success',
        result,
      });
    } catch (error) {
      results.push({
        idCuenta: cuenta.id,
        status: 'error',
        error: error instanceof Error ? error.message : 'No se pudo sincronizar la cuenta.',
      });
    }
  }

  return {
    processed: results.length,
    successCount: results.filter((item) => item.status === 'success').length,
    errorCount: results.filter((item) => item.status === 'error').length,
    results,
  };
}

async function sincronizarTransaccionesEntrantes({ environment, minutes = 30, personaCbus } = {}) {
  const transaccionesDelCentral = await listarTransacciones({ environment, minutes });

  if (!Array.isArray(transaccionesDelCentral) || transaccionesDelCentral.length === 0) {
    return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
  }

  const cbuResult =
    Array.isArray(personaCbus) && personaCbus.length > 0
      ? await q.seleccionarCuentasActivasPorCbus(pool, personaCbus)
      : await q.seleccionarCuentasActivasConCbu(pool);

  const ourCbus = new Map(cbuResult.rows.map((row) => [row.cbu, row]));

  // Filter candidates first to avoid checking IDs we'll skip anyway
  const candidates = transaccionesDelCentral
    .filter((tx) => tx.estado === 'aprobada' && ourCbus.has(tx.cbuDestino))
    .map((tx) => ({ ...tx, _txId: tx._id || tx.id || tx.transaccionId }))
    .filter((tx) => Boolean(tx._txId));

  if (candidates.length === 0) {
    return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
  }

  // Single batch query instead of N individual queries
  const candidateIds = candidates.map((tx) => tx._txId);
  const existingResult = await q.selectExistingIncomingTxIds(pool, candidateIds);
  const existingIds = new Set(existingResult.rows.map((r) => r.central_transaction_id));

  const results = [];

  for (const tx of candidates) {
    const txId = tx._txId;
    const cbuDestino = tx.cbuDestino;
    if (existingIds.has(txId)) {
      results.push({ id: txId, status: 'already_recorded' });
      continue;
    }

    // El importe viene como número JSON desde el Banco Central. Se normaliza a
    // decimal exacto antes de acreditarlo para no arrastrar el float a la BD.
    let importeExacto;
    try {
      importeExacto = Dinero.desde(tx.importe).redondeado();
    } catch {
      results.push({ id: tx._txId, status: 'error', error: `Importe inválido: ${tx.importe}` });
      continue;
    }
    const importe = importeExacto.aString();

    const cuentaDestino = ourCbus.get(cbuDestino);
    const senderName = [tx.personaOrigen?.nombre, tx.personaOrigen?.apellido]
      .filter(Boolean)
      .join(' ') || null;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const typeResult = await q.seleccionarIdTipoTransferencia(client);

      if (typeResult.rowCount === 0) {
        throw new HttpError(500, 'No se encontró el tipo de transacción transferencia.');
      }

      await q.acreditarEnCuenta(client, importe, cuentaDestino.id);

      await q.insertarTransaccionEntrante(client, {
        typeId: typeResult.rows[0].id,
        idCuentaDestino: cuentaDestino.id,
        importe,
        txId,
        cbuOrigen: tx.cbuOrigen,
        cbuDestino,
        senderName,
      });

      await client.query('COMMIT');
      results.push({ id: txId, status: 'synced', importe, cbuDestino, senderName });
    } catch (error) {
      await client.query('ROLLBACK');
      results.push({
        id: txId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.release();
    }
  }

  return {
    processed: results.length,
    synced: results.filter((r) => r.status === 'synced').length,
    already_recorded: results.filter((r) => r.status === 'already_recorded').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
}

async function saveBankRegistration(centralResponse) {
  const bankId = centralResponse.bankId;
  const bankCode = centralResponse.bankCode;
  const name = centralResponse.name;
  const environment = normalizeEnvironment(centralResponse.environment);
  const apiKey = centralResponse.apiKey || centralResponse.api_key;

  if (apiKey) {
    await upsertCentralBankConfig({
      environment,
      apiKey,
      bankName: name,
    });
  }

  if (!bankId || bankCode === undefined || !name) {
    return null;
  }

  const result = await q.upsertBankRegistration(pool, { bankId, bankCode, name, environment });

  return result.rows[0];
}

module.exports = {
  abrirCuentaCentral,
  asignarAliasDeCuenta,
  assignAlias,
  buscarCuentaPorAlias,
  buscarCuentaPorCbu,
  consultarSituacionCrediticia,
  crearTransaccion,
  extractCentralCbu,
  extractCentralAlias,
  extraerIdTransaccionCentral,
  findPersonByAlias,
  findPersonByCbu,
  getBankByCode,
  getConfig,
  getLocalRegistration,
  informarDeuda,
  listBanks,
  listarCuentasASincronizar,
  listarTransacciones,
  registerBank,
  registrarPersonaLocalDesdeCentral,
  registerPerson,
  saveConfig,
  sincronizarCuenta,
  sincronizarCuentas,
  sincronizarTransaccionesEntrantes,
  updateBankName,
};
