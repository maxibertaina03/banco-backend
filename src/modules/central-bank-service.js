const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
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
const { writeAuditLog } = require('../utils/audit');
const { createTTLCache } = require('../utils/ttl-cache');
const {
  generateLocalAccountNumber,
  sanitizeCentralText,
  sanitizeDni,
  buildAliasCandidates,
  extractCentralCbu,
  extractCentralTransactionId,
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

async function getSyncAccountById(accountId) {
  const result = await q.selectSyncAccountById(pool, accountId);
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

async function registerLocalPersonFromCentral(
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
      await q.insertPersonaRole(client, persona.id, roleResult.rows[0].id);
    }

    const accountTypeResult = await q.selectAccountTypeByName(client, DEFAULT_ACCOUNT_TYPE_NAME);

    if (accountTypeResult.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de cuenta Caja de Ahorro.');
    }

    const cbuOwnerResult = await q.selectAccountOwnerByCbu(client, centralCbu);

    if (cbuOwnerResult.rowCount > 0 && cbuOwnerResult.rows[0].persona_id !== persona.id) {
      throw new HttpError(409, 'El CBU devuelto por Banco Central ya está asociado a otra persona local.');
    }

    let accountResult;

    if (cbuOwnerResult.rowCount > 0) {
      accountResult = await q.selectAccountById(client, cbuOwnerResult.rows[0].id);
    } else {
      accountResult = await q.selectFirstAccountByPersona(client, persona.id);
    }

    let account;

    if (accountResult.rowCount > 0) {
      account = (
        await q.linkAccountToCentral(client, {
          cbu: centralCbu,
          alias: centralAlias,
          id: accountResult.rows[0].id,
        })
      ).rows[0];
    } else {
      let createdAccount = null;
      let attempts = 0;

      while (!createdAccount && attempts < 5) {
        attempts += 1;

        try {
          createdAccount = (
            await q.insertAccountFromCentral(client, {
              personaId: persona.id,
              tipoCuentaId: accountTypeResult.rows[0].id,
              numeroCuenta: generateLocalAccountNumber(persona.id),
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

      if (!createdAccount) {
        throw new HttpError(500, 'No se pudo generar una cuenta local única para la persona.');
      }

      account = createdAccount;
    }

    await writeAuditLog(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'CREATE',
      entidad: 'personas',
      entidadId: persona.id,
      payloadDespues: {
        source: 'central-bank',
        centralStatus: registrationResponse.status,
        persona,
        cuenta: account,
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
      cuenta: account,
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

  await q.updateAccountAlias(pool, alias, cbu);

  return centralResponse;
}

async function findPersonByAlias(alias, environment) {
  return requestWithApiKey('get', `/persons/alias/${encodeURIComponent(alias)}`, {
    environment,
  });
}

async function createTransaction(payload, environment, { includeResponseMeta = false } = {}) {
  return requestWithApiKey('post', '/transactions', {
    data: payload,
    environment,
    includeResponseMeta,
  });
}

async function listTransactions({ environment, minutes } = {}) {
  return requestWithApiKey('get', '/transactions', {
    environment,
    params: minutes ? { minutos: minutes } : undefined,
  });
}

async function listSyncAccounts({ environment, limit = DEFAULT_SYNC_LIMIT } = {}) {
  normalizeEnvironment(environment);

  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(Number(limit), 200))
    : DEFAULT_SYNC_LIMIT;

  const result = await q.selectSyncAccounts(pool, safeLimit);

  return result.rows.map((account) => {
    const issues = toSyncIssues(account);
    return {
      ...account,
      sync_ready: issues.length === 0,
      sync_issues: issues,
      suggested_alias: buildAliasCandidates(account, 'orbital')[0] || null,
    };
  });
}

async function syncAccount(accountId, environment) {
  const config = await getCentralBankConfig(environment);
  const account = await getSyncAccountById(accountId);

  if (!account) {
    throw new HttpError(404, 'No se encontró la cuenta indicada.');
  }

  const issues = toSyncIssues(account);

  if (issues.length > 0) {
    throw new HttpError(400, `La cuenta no está lista para sincronizar. ${issues.join(' ')}`);
  }

  const payload = {
    nombre: sanitizeCentralText(account.nombre),
    apellido: sanitizeCentralText(account.apellido),
    dni: sanitizeDni(account.dni),
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
    const aliasCandidates = buildAliasCandidates(account, config.bank_name);
    aliasAttempt = await tryAssignAlias(centralCbu, aliasCandidates, environment);
  }

  const updatedAccount = await q.updateAccountSyncResult(pool, {
    cbu: centralCbu,
    alias: aliasAttempt.assignedAlias,
    accountId,
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

  if (centralCbu !== account.cbu) {
    warnings.push(
      `El CBU local se actualizó desde ${account.cbu} a ${centralCbu} para mantener consistencia con el Banco Central.`
    );
  }

  return {
    account: {
      ...updatedAccount.rows[0],
      tipo_cuenta_nombre: account.tipo_cuenta_nombre,
      nombre: account.nombre,
      apellido: account.apellido,
      dni: account.dni,
      email: account.email,
    },
    persona: {
      id: account.persona_id,
      nombre: account.nombre,
      apellido: account.apellido,
      dni: account.dni,
      email: account.email,
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

async function syncAccounts({ environment, accountIds, limit = DEFAULT_SYNC_LIMIT } = {}) {
  const accounts = Array.isArray(accountIds) && accountIds.length > 0
    ? await Promise.all(accountIds.map((accountId) => getSyncAccountById(accountId)))
    : await listSyncAccounts({ environment, limit });

  const filteredAccounts = accounts.filter(Boolean);
  const results = [];

  for (const account of filteredAccounts) {
    try {
      const result = await syncAccount(account.id, environment);
      results.push({
        accountId: account.id,
        status: 'success',
        result,
      });
    } catch (error) {
      results.push({
        accountId: account.id,
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

async function syncIncomingTransactions({ environment, minutes = 30, personaCbus } = {}) {
  const centralTransactions = await listTransactions({ environment, minutes });

  if (!Array.isArray(centralTransactions) || centralTransactions.length === 0) {
    return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
  }

  const cbuResult =
    Array.isArray(personaCbus) && personaCbus.length > 0
      ? await q.selectActiveAccountsByCbus(pool, personaCbus)
      : await q.selectAllActiveAccountsWithCbu(pool);

  const ourCbus = new Map(cbuResult.rows.map((row) => [row.cbu, row]));

  // Filter candidates first to avoid checking IDs we'll skip anyway
  const candidates = centralTransactions
    .filter((tx) => tx.estado === 'aprobada' && ourCbus.has(tx.cbuDestino))
    .map((tx) => ({ ...tx, _txId: tx._id || tx.id || tx.transactionId }))
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
    const importe = tx.importe;

    if (existingIds.has(txId)) {
      results.push({ id: txId, status: 'already_recorded' });
      continue;
    }

    const destAccount = ourCbus.get(cbuDestino);
    const senderName = [tx.personaOrigen?.nombre, tx.personaOrigen?.apellido]
      .filter(Boolean)
      .join(' ') || null;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const typeResult = await q.selectTransferTypeId(client);

      if (typeResult.rowCount === 0) {
        throw new HttpError(500, 'No se encontró el tipo de transacción transferencia.');
      }

      await q.creditAccount(client, importe, destAccount.id);

      await q.insertIncomingTransaction(client, {
        typeId: typeResult.rows[0].id,
        destAccountId: destAccount.id,
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
  assignAlias,
  createTransaction,
  extractCentralCbu,
  extractCentralAlias,
  extractCentralTransactionId,
  findPersonByAlias,
  findPersonByCbu,
  getBankByCode,
  getConfig,
  getLocalRegistration,
  listBanks,
  listSyncAccounts,
  listTransactions,
  registerBank,
  registerLocalPersonFromCentral,
  registerPerson,
  saveConfig,
  syncAccount,
  syncAccounts,
  syncIncomingTransactions,
  updateBankName,
};
