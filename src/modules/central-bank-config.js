const pool = require('../db/pool');
const HttpError = require('../utils/http-error');

const DEFAULT_API_URL = 'https://centralbank.brocoly.cc/api';
const DEFAULT_ENVIRONMENT = 'test';

function normalizeEnvironment(environment) {
  return environment || DEFAULT_ENVIRONMENT;
}

function maskSecret(value) {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return '********';
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function toPublicConfig(row) {
  if (!row) {
    return null;
  }

  return {
    environment: row.environment,
    apiUrl: row.api_url,
    registerToken: maskSecret(row.register_token),
    apiKey: maskSecret(row.api_key),
    bankName: row.bank_name,
    activo: row.activo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getCentralBankConfig(environment) {
  const effectiveEnvironment = normalizeEnvironment(environment);
  const result = await pool.query(
    `SELECT environment, api_url, register_token, api_key, bank_name, activo, created_at, updated_at
     FROM banco_central_configuracion
     WHERE environment = $1 AND activo = TRUE
     LIMIT 1`,
    [effectiveEnvironment]
  );

  const config = result.rows[0];

  if (!config) {
    throw new HttpError(
      500,
      `Falta configurar el Banco Central para el entorno "${effectiveEnvironment}" en banco_central_configuracion.`
    );
  }

  return config;
}

async function getPublicCentralBankConfig(environment) {
  const effectiveEnvironment = normalizeEnvironment(environment);
  const result = await pool.query(
    `SELECT environment, api_url, register_token, api_key, bank_name, activo, created_at, updated_at
     FROM banco_central_configuracion
     WHERE environment = $1
     LIMIT 1`,
    [effectiveEnvironment]
  );

  return toPublicConfig(result.rows[0]);
}

async function upsertCentralBankConfig(payload) {
  const effectiveEnvironment = normalizeEnvironment(payload.environment);
  const result = await pool.query(
    `INSERT INTO banco_central_configuracion (
       environment,
       api_url,
       register_token,
       api_key,
       bank_name,
       activo
     )
     VALUES ($1, COALESCE($2, $3), $4, $5, $6, COALESCE($7, TRUE))
     ON CONFLICT (environment)
     DO UPDATE SET
       api_url = COALESCE($2, banco_central_configuracion.api_url),
       register_token = COALESCE(EXCLUDED.register_token, banco_central_configuracion.register_token),
       api_key = COALESCE(EXCLUDED.api_key, banco_central_configuracion.api_key),
       bank_name = COALESCE(EXCLUDED.bank_name, banco_central_configuracion.bank_name),
       activo = COALESCE($7, banco_central_configuracion.activo),
       updated_at = NOW()
     RETURNING environment, api_url, register_token, api_key, bank_name, activo, created_at, updated_at`,
    [
      effectiveEnvironment,
      payload.apiUrl,
      DEFAULT_API_URL,
      payload.registerToken,
      payload.apiKey,
      payload.bankName,
      payload.activo,
    ]
  );

  return toPublicConfig(result.rows[0]);
}

module.exports = {
  DEFAULT_API_URL,
  DEFAULT_ENVIRONMENT,
  getCentralBankConfig,
  getPublicCentralBankConfig,
  normalizeEnvironment,
  upsertCentralBankConfig,
};
