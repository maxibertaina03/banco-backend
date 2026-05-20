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

const DEFAULT_SYNC_LIMIT = 25;
const MIN_ALIAS_LENGTH = 6;
const MAX_ALIAS_LENGTH = 20;
const DEFAULT_ACCOUNT_TYPE_NAME = 'Caja de Ahorro';

// Cache for listBanks — the bank list changes only when banks register/rename.
// TTL: 5 minutes per environment.
const BANKS_TTL_MS = 5 * 60 * 1000;
const banksCache = new Map(); // `${environment}` → { value, expiresAt }

function getBanksCached(env) {
  const entry = banksCache.get(env);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  banksCache.delete(env);
  return null;
}

function setBanksCached(env, value) {
  banksCache.set(env, { value, expiresAt: Date.now() + BANKS_TTL_MS });
}

function generateLocalAccountNumber(personaId) {
  const personaDigits = String(personaId || '').replace(/\D+/g, '').slice(-6).padStart(6, '0');
  const timestampDigits = Date.now().toString().slice(-6);
  return `${personaDigits}${timestampDigits}`.slice(0, 12);
}

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

    // API docs: POST /transactions returns "transaccionId" (Spanish spelling)
    // GET /transactions returns "_id"
    const candidates = [
      current.transaccionId,
      current.transactionId,
      current.transaction_id,
      current._id,
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
  const env = normalizeEnvironment(environment);
  const cached = getBanksCached(env);
  if (cached) return cached;

  const result = await requestWithApiKey('get', '/banks', { environment });
  setBanksCached(env, result);
  return result;
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

    let personaResult = await client.query(
      `SELECT *
       FROM personas
       WHERE dni = $1
       LIMIT 1`,
      [sanitizedPayload.dni]
    );

    let persona;

    if (personaResult.rowCount > 0) {
      persona = (
        await client.query(
          `UPDATE personas
           SET nombre = $1,
               apellido = $2,
               email = COALESCE($3, email),
               telefono = COALESCE($4, telefono)
           WHERE id = $5
           RETURNING *`,
          [sanitizedPayload.nombre, sanitizedPayload.apellido, email, telefono, personaResult.rows[0].id]
        )
      ).rows[0];
    } else {
      persona = (
        await client.query(
          `INSERT INTO personas (
             nombre,
             apellido,
             dni,
             email,
             telefono,
             perfil_completo
           ) VALUES ($1, $2, $3, $4, $5, false)
           RETURNING *`,
          [sanitizedPayload.nombre, sanitizedPayload.apellido, sanitizedPayload.dni, email, telefono]
        )
      ).rows[0];
    }

    const roleResult = await client.query(
      `SELECT id
       FROM roles
       WHERE LOWER(nombre) = 'cliente'
       LIMIT 1`
    );

    if (roleResult.rowCount > 0) {
      await client.query(
        `INSERT INTO personas_roles (persona_id, rol_id)
         VALUES ($1, $2)
         ON CONFLICT (persona_id, rol_id) DO NOTHING`,
        [persona.id, roleResult.rows[0].id]
      );
    }

    const accountTypeResult = await client.query(
      `SELECT id
       FROM tipos_cuenta
       WHERE nombre = $1
       ORDER BY id ASC
       LIMIT 1`,
      [DEFAULT_ACCOUNT_TYPE_NAME]
    );

    if (accountTypeResult.rowCount === 0) {
      throw new HttpError(500, 'No se encontró el tipo de cuenta Caja de Ahorro.');
    }

    const cbuOwnerResult = await client.query(
      `SELECT id, persona_id
       FROM cuentas
       WHERE cbu = $1
       LIMIT 1`,
      [centralCbu]
    );

    if (cbuOwnerResult.rowCount > 0 && cbuOwnerResult.rows[0].persona_id !== persona.id) {
      throw new HttpError(409, 'El CBU devuelto por Banco Central ya está asociado a otra persona local.');
    }

    let accountResult;

    if (cbuOwnerResult.rowCount > 0) {
      accountResult = await client.query(
        `SELECT *
         FROM cuentas
         WHERE id = $1
         LIMIT 1`,
        [cbuOwnerResult.rows[0].id]
      );
    } else {
      accountResult = await client.query(
        `SELECT *
         FROM cuentas
         WHERE persona_id = $1
         ORDER BY created_at ASC
         LIMIT 1`,
        [persona.id]
      );
    }

    let account;

    if (accountResult.rowCount > 0) {
      account = (
        await client.query(
          `UPDATE cuentas
           SET cbu = $1,
               alias = COALESCE($2, alias),
               activa = TRUE,
               banco_central_registrada = TRUE
           WHERE id = $3
           RETURNING *`,
          [centralCbu, centralAlias, accountResult.rows[0].id]
        )
      ).rows[0];
    } else {
      let createdAccount = null;
      let attempts = 0;

      while (!createdAccount && attempts < 5) {
        attempts += 1;

        try {
          createdAccount = (
            await client.query(
              `INSERT INTO cuentas (
                 persona_id,
                 tipo_cuenta_id,
                 numero_cuenta,
                 cbu,
                 alias,
                 saldo,
                 activa,
                 banco_central_registrada
               ) VALUES ($1, $2, $3, $4, $5, 0, TRUE, TRUE)
               RETURNING *`,
              [
                persona.id,
                accountTypeResult.rows[0].id,
                generateLocalAccountNumber(persona.id),
                centralCbu,
                centralAlias,
              ]
            )
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

  await pool.query('UPDATE cuentas SET alias = $1 WHERE cbu = $2', [alias, cbu]);

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

async function syncIncomingTransactions({ environment, minutes = 30, personaCbus } = {}) {
  const centralTransactions = await listTransactions({ environment, minutes });

  if (!Array.isArray(centralTransactions) || centralTransactions.length === 0) {
    return { processed: 0, synced: 0, already_recorded: 0, errors: 0, results: [] };
  }

  const cbuResult =
    Array.isArray(personaCbus) && personaCbus.length > 0
      ? await pool.query(
          'SELECT id, cbu FROM cuentas WHERE cbu = ANY($1::text[]) AND activa = TRUE',
          [personaCbus]
        )
      : await pool.query('SELECT id, cbu FROM cuentas WHERE cbu IS NOT NULL AND activa = TRUE');

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
  const existingResult = await pool.query(
    'SELECT central_transaction_id FROM transacciones WHERE central_transaction_id = ANY($1) AND canal = $2',
    [candidateIds, 'interbancaria_entrante']
  );
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

      const typeResult = await client.query(
        "SELECT id FROM tipos_transaccion WHERE LOWER(nombre) = 'transferencia' LIMIT 1"
      );

      if (typeResult.rowCount === 0) {
        throw new HttpError(500, 'No se encontró el tipo de transacción transferencia.');
      }

      await client.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [importe, destAccount.id]);

      await client.query(
        `INSERT INTO transacciones (
           tipo_transaccion_id,
           cuenta_destino_id,
           monto,
           estado,
           central_transaction_id,
           canal,
           cbu_origen,
           cbu_destino,
           descripcion
         ) VALUES ($1, $2, $3, 'completada', $4, 'interbancaria_entrante', $5, $6, $7)`,
        [typeResult.rows[0].id, destAccount.id, importe, txId, tx.cbuOrigen, cbuDestino, senderName]
      );

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
  registerLocalPersonFromCentral,
  registerPerson,
  saveConfig,
  syncAccount,
  syncAccounts,
  syncIncomingTransactions,
  updateBankName,
};
