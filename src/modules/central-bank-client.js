const axios = require('axios');
const HttpError = require('../utils/http-error');
const { getCentralBankConfig, normalizeEnvironment } = require('./central-bank-config');

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

function buildBaseUrl(apiUrl) {
  return apiUrl.replace(/\/$/, '');
}

function assertRegisterToken(config) {
  if (!config.register_token) {
    throw new HttpError(
      500,
      `Falta register_token en banco_central_configuracion para el entorno "${config.environment}".`
    );
  }
}

function assertApiKey(config) {
  if (!config.api_key) {
    throw new HttpError(
      500,
      `Falta api_key en banco_central_configuracion para el entorno "${config.environment}".`
    );
  }
}

function mapCentralBankError(error) {
  if (error instanceof HttpError) return error;

  if (error.response) {
    const status = error.response.status;

    if (status === 429) {
      return new HttpError(
        429,
        'El Banco Central está limitando las solicitudes. Esperá unos segundos e intentá de nuevo.',
        { centralBank: error.response.data }
      );
    }

    if (status === 404) {
      return new HttpError(
        404,
        'El CBU o alias indicado no existe en el Banco Central.',
        { centralBank: error.response.data }
      );
    }

    const message =
      error.response.data?.error ||
      error.response.data?.message ||
      'El Banco Central rechazó la solicitud.';

    return new HttpError(status, message, { centralBank: error.response.data });
  }

  if (error.request) {
    return new HttpError(502, 'No se pudo conectar con la API del Banco Central. Verificá tu conexión e intentá de nuevo.');
  }

  return error;
}

function isRetryable(error) {
  // No reintentar errores 4xx: son permanentes (bad request, not found, conflict)
  if (error instanceof HttpError && error.status >= 400 && error.status < 500) return false;
  // No reintentar rate limit (429): el reintento inmediato empeoraría la situación
  if (error instanceof HttpError && error.status === 429) return false;
  // Reintentar 5xx y errores de red/timeout
  return true;
}

async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const mapped = error instanceof HttpError ? error : mapCentralBankError(error);
      lastError = mapped;

      if (!isRetryable(mapped) || attempt === maxRetries - 1) {
        throw mapped;
      }

      // Backoff exponencial: 500ms, 1000ms, 2000ms...
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
    }
  }

  throw lastError;
}

async function requestWithRegisterToken(
  method,
  url,
  { data, params, environment, includeResponseMeta } = {}
) {
  const config = await getCentralBankConfig(environment);
  assertRegisterToken(config);

  return withRetry(async () => {
    const response = await axios.request({
      method,
      baseURL: buildBaseUrl(config.api_url),
      url,
      data,
      params,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${config.register_token}`,
        'Content-Type': 'application/json',
        'x-environment': normalizeEnvironment(environment),
      },
    });

    if (includeResponseMeta) return { status: response.status, data: response.data };
    return response.data;
  });
}

async function requestWithApiKey(
  method,
  url,
  { data, params, environment, includeResponseMeta } = {}
) {
  const config = await getCentralBankConfig(environment);
  assertApiKey(config);

  return withRetry(async () => {
    const response = await axios.request({
      method,
      baseURL: buildBaseUrl(config.api_url),
      url,
      data,
      params,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'x-api-key': config.api_key,
        'Content-Type': 'application/json',
        'x-environment': normalizeEnvironment(environment),
      },
    });

    if (includeResponseMeta) return { status: response.status, data: response.data };
    return response.data;
  });
}

module.exports = {
  requestWithApiKey,
  requestWithRegisterToken,
};
