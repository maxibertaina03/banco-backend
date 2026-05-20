const axios = require('axios');
const HttpError = require('../utils/http-error');
const { getCentralBankConfig, normalizeEnvironment } = require('./central-bank-config');

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
  if (error instanceof HttpError) {
    return error;
  }

  if (error.response) {
    const status = error.response.status;

    if (status === 429) {
      return new HttpError(
        429,
        'El Banco Central está limitando las solicitudes. Espera unos segundos e intenta de nuevo.',
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

    return new HttpError(status, message, {
      centralBank: error.response.data,
    });
  }

  if (error.request) {
    return new HttpError(502, 'No se pudo conectar con la API del Banco Central. Verifica tu conexión e intenta de nuevo.');
  }

  return error;
}

async function requestWithRegisterToken(
  method,
  url,
  { data, params, environment, includeResponseMeta } = {}
) {
  const config = await getCentralBankConfig(environment);
  assertRegisterToken(config);

  try {
    const response = await axios.request({
      method,
      baseURL: buildBaseUrl(config.api_url),
      url,
      data,
      params,
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${config.register_token}`,
        'Content-Type': 'application/json',
        'x-environment': normalizeEnvironment(environment),
      },
    });

    if (includeResponseMeta) {
      return {
        status: response.status,
        data: response.data,
      };
    }

    return response.data;
  } catch (error) {
    throw mapCentralBankError(error);
  }
}

async function requestWithApiKey(
  method,
  url,
  { data, params, environment, includeResponseMeta } = {}
) {
  const config = await getCentralBankConfig(environment);
  assertApiKey(config);

  try {
    const response = await axios.request({
      method,
      baseURL: buildBaseUrl(config.api_url),
      url,
      data,
      params,
      timeout: 10000,
      headers: {
        'x-api-key': config.api_key,
        'Content-Type': 'application/json',
        'x-environment': normalizeEnvironment(environment),
      },
    });

    if (includeResponseMeta) {
      return {
        status: response.status,
        data: response.data,
      };
    }

    return response.data;
  } catch (error) {
    throw mapCentralBankError(error);
  }
}

module.exports = {
  requestWithApiKey,
  requestWithRegisterToken,
};
