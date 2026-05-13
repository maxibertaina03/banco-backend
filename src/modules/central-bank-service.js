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

const DEFAULT_SYNC_LIMIT = 25;
const MIN_ALIAS_LENGTH = 6;
const MAX_ALIAS_LENGTH = 20;

function sanitizeCentralText(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

function sanitizeDni(value) {
  if (!value) {
    return null;
  }

  const digits = String(value).replace(/\D+/g, '');
  return digits || null;
}

function cleanAliasText(value) {
  if (!value) {
    return null;
  }

  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');

  return normalized || null;
}

function normalizeAliasValue(value) {
  const normalized = cleanAliasText(value)?.slice(0, MAX_ALIAS_LENGTH) || null;

  if (!normalized || normalized.length < MIN_ALIAS_LENGTH) {
    return null;
  }

  return normalized;
}

function createAliasVariant(parts) {
  const normalizedParts = parts
    .map((part) => cleanAliasText(String(part || '').replace(/\./g, '')))
    .filter(Boolean);

  if (normalizedParts.length === 0) {
    return null;
  }

  return normalizeAliasValue(normalizedParts.join('.'));
}

function buildAliasCandidates(account, bankName) {
  const suffix = account.numero_cuenta?.slice(-4) || account.cbu?.slice(-4) || '0001';
  const bankSlug = normalizeAliasValue(bankName || 'orbital') || 'orbital';

  const candidates = [
    normalizeAliasValue(account.alias),
    createAliasVariant([account.nombre, account.apellido]),
    createAliasVariant([account.nombre, suffix]),
    createAliasVariant([account.nombre, account.apellido, suffix]),
    createAliasVariant([account.nombre, bankSlug]),
    createAliasVariant([account.nombre, suffix, bankSlug]),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

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

function extractCentralCbu(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (typeof current.cbu === 'string' && current.cbu.trim()) {
      return current.cbu.trim();
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

function extractCentralTransactionId(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    const candidates = [
      current.transactionId,
      current.transaction_id,
      current.transferId,
      current.transfer_id,
      current.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
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

function extractCentralAlias(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (typeof current.alias === 'string' && current.alias.trim()) {
      return current.alias.trim();
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return null;
}

function toSyncIssues(account) {
  const issues = [];
  const sanitizedNombre = sanitizeCentralText(account.nombre);
  const sanitizedApellido = sanitizeCentralText(account.apellido);
  const sanitizedDni = sanitizeDni(account.dni);

  if (!account.activa) {
    issues.push('La cuenta está inactiva.');
  }

  if (!sanitizedNombre || !sanitizedApellido) {
    issues.push('La persona asociada no tiene nombre y apellido completos.');
  }

  if (!sanitizedDni) {
    issues.push('La persona asociada no tiene DNI.');
  } else if (sanitizedDni.length < 7 || sanitizedDni.length > 8) {
    issues.push('El DNI debe tener 7 u 8 dígitos para sincronizar con Brocoly.');
  }

  return issues;
}

async function getSyncAccountById(accountId) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.persona_id,
       c.tipo_cuenta_id,
       c.numero_cuenta,
       c.cbu,
       c.alias,
       c.saldo,
       c.activa,
       c.banco_central_registrada,
       c.created_at,
       p.nombre,
       p.apellido,
       p.dni,
       p.email,
       tc.nombre AS tipo_cuenta_nombre
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
     WHERE c.id = $1
     LIMIT 1`,
    [accountId]
  );

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
  const registry = await pool.query(
    `UPDATE banco_central_registro
     SET nombre = $1
     WHERE environment = $2
     RETURNING *`,
    [name, effectiveEnvironment]
  );

  return {
    centralBank: centralResponse,
    config,
    registry: registry.rows[0] || null,
  };
}

async function listBanks(environment) {
  return requestWithApiKey('get', '/banks', {
    environment,
  });
}

async function getBankByCode(bankCode, environment) {
  return requestWithApiKey('get', `/banks/${encodeURIComponent(bankCode)}`, {
    environment,
  });
}

async function getLocalRegistration(environment) {
  const effectiveEnvironment = normalizeEnvironment(environment);
  const result = await pool.query(
    `SELECT *
     FROM banco_central_registro
     WHERE environment = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [effectiveEnvironment]
  );

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

  await pool.query('UPDATE cuentas SET alias = $1 WHERE cbu = $2', [alias, cbu]);

  return centralResponse;
}

async function findPersonByAlias(alias, environment) {
  return requestWithApiKey('get', `/persons/alias/${encodeURIComponent(alias)}`, {
    environment,
  });
}

async function createTransaction(payload, environment) {
  return requestWithApiKey('post', '/transactions', {
    data: payload,
    environment,
  });
}

async function listTransactions(environment) {
  return requestWithApiKey('get', '/transactions', {
    environment,
  });
}

async function listSyncAccounts({ environment, limit = DEFAULT_SYNC_LIMIT } = {}) {
  normalizeEnvironment(environment);

  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(Number(limit), 200))
    : DEFAULT_SYNC_LIMIT;

  const result = await pool.query(
    `SELECT
       c.id,
       c.persona_id,
       c.tipo_cuenta_id,
       c.numero_cuenta,
       c.cbu,
       c.alias,
       c.saldo,
       c.activa,
       c.banco_central_registrada,
       c.created_at,
       p.nombre,
       p.apellido,
       p.dni,
       p.email,
       tc.nombre AS tipo_cuenta_nombre
     FROM cuentas c
     JOIN personas p ON p.id = c.persona_id
     JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows.map((account) => ({
    ...account,
    sync_ready: toSyncIssues(account).length === 0,
    sync_issues: toSyncIssues(account),
    suggested_alias: buildAliasCandidates(account, 'orbital')[0] || null,
  }));
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

  const updatedAccount = await pool.query(
    `UPDATE cuentas
     SET cbu = $1,
         alias = COALESCE($2, alias),
         banco_central_registrada = TRUE
     WHERE id = $3
     RETURNING *`,
    [centralCbu, aliasAttempt.assignedAlias, accountId]
  );

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

  const result = await pool.query(
    `INSERT INTO banco_central_registro (bank_id, bank_code, nombre, environment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bank_id, environment)
     DO UPDATE SET
       bank_code = EXCLUDED.bank_code,
       nombre = EXCLUDED.nombre
     RETURNING *`,
    [bankId, bankCode, name, environment]
  );

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
  registerPerson,
  saveConfig,
  syncAccount,
  syncAccounts,
  updateBankName,
};
