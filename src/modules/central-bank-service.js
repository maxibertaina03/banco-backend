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
  const registry = await pool.query(
    `UPDATE banco_central_registro
     SET nombre = $1
     WHERE environment = $2
     RETURNING *`,
    [name, effectiveEnvironment]
  );

  return {
    centralBank: centralResponse,
    registry: registry.rows[0] || null,
  };
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

async function registerPerson(payload, environment) {
  return requestWithApiKey('post', '/persons', {
    data: payload,
    environment,
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
  findPersonByAlias,
  findPersonByCbu,
  getConfig,
  getLocalRegistration,
  listTransactions,
  registerBank,
  registerPerson,
  saveConfig,
  updateBankName,
};
