// Cliente HTTP de banco-proveedores (servicios y recargas).
//
// Es un tercero: se cae, tarda, o contesta que no. Todo eso se contiene acá
// para que el resto del backend no vea nunca un error de axios y para que la
// traducción a códigos HTTP nuestros esté en un solo lugar.
//
// A diferencia del cliente de mercado, acá NO hay caché ni último valor
// conocido: una deuda vieja llevaría a cobrar una factura que ya se pagó.
// Si el proveedor no responde, la operación falla y no se debita nada.

const axios = require('axios');
const env = require('../../config/env');
const HttpError = require('../../utils/http-error');
const logger = require('../../utils/logger');

// Corto a propósito: el cliente está esperando con la pantalla abierta, y un
// pago colgado es peor que un pago que falla rápido y se puede reintentar.
const TIMEOUT_MS = 5_000;

/**
 * Traduce un error del proveedor a uno nuestro.
 *
 * La distinción que importa para la pantalla:
 *   - 502 → el proveedor contestó y **rechazó**. No se debitó nada.
 *   - 503 → el proveedor no contestó. Tampoco se debitó nada, pero conviene reintentar.
 */
function traducirError(error, accion) {
  const respuesta = error.response;

  if (!respuesta) {
    logger.error({ err: error, subsystem: 'proveedores', accion }, 'el proveedor no respondió');
    throw new HttpError(503, 'El proveedor no está disponible en este momento. Intentá de nuevo en unos minutos.');
  }

  const mensajeDelProveedor = respuesta.data?.error || respuesta.data?.message;

  // 404 y 409 son respuestas legítimas del negocio: se pasan tal cual.
  if (respuesta.status === 404) throw new HttpError(404, mensajeDelProveedor || 'El proveedor no encontró el recurso.');
  if (respuesta.status === 409) throw new HttpError(409, mensajeDelProveedor || 'La operación ya estaba hecha.');

  if (respuesta.status >= 500) {
    logger.error({ subsystem: 'proveedores', accion, status: respuesta.status }, 'el proveedor falló');
    throw new HttpError(503, 'El proveedor no está disponible en este momento. Intentá de nuevo en unos minutos.');
  }

  // 401 y 403 son un problema de configuración nuestra, no del cliente: se
  // loguea fuerte, pero el mensaje del proveedor ("La API key no es válida") no
  // se le muestra a nadie, porque no le dice nada y delata el motivo real.
  if (respuesta.status === 401 || respuesta.status === 403) {
    logger.error({ subsystem: 'proveedores', accion }, 'el proveedor rechazó nuestra API key');
    throw new HttpError(502, 'El proveedor rechazó la operación.');
  }

  throw new HttpError(502, mensajeDelProveedor || 'El proveedor rechazó la operación.');
}

function createProveedoresClient({
  baseUrl = env.proveedoresUrl,
  apiKey = env.proveedoresApiKey,
  http = axios,
} = {}) {
  async function pedir(metodo, ruta, { body = null, idempotencyKey = null, accion } = {}) {
    if (!baseUrl) {
      throw new HttpError(503, 'El servicio de pagos no está configurado.');
    }

    const headers = { 'x-api-key': apiKey, Accept: 'application/json' };
    // Se reenvía la misma clave que mandó el cliente: si el banco reintenta, el
    // proveedor tampoco ejecuta dos veces.
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    try {
      const respuesta = await http.request({
        method: metodo,
        url: `${baseUrl.replace(/\/$/, '')}${ruta}`,
        data: body ?? undefined,
        headers,
        timeout: TIMEOUT_MS,
      });
      return respuesta.data;
    } catch (error) {
      return traducirError(error, accion || `${metodo} ${ruta}`);
    }
  }

  return {
    listarEmpresas: (rubro) =>
      pedir('get', `/empresas${rubro ? `?rubro=${encodeURIComponent(rubro)}` : ''}`, { accion: 'listar empresas' }),

    consultarDeuda: (empresaId, numeroCliente) =>
      pedir(
        'get',
        `/empresas/${encodeURIComponent(empresaId)}/deuda?numero_cliente=${encodeURIComponent(numeroCliente)}`,
        { accion: 'consultar deuda' }
      ),

    // El proveedor habla de `importe`; hacia el cliente el banco expone `monto`.
    // La traducción vive en el service, no acá.
    pagarFactura: (empresaId, { facturaId, importe }, idempotencyKey) =>
      pedir('post', `/empresas/${encodeURIComponent(empresaId)}/pagos`, {
        body: { factura_id: facturaId, importe },
        idempotencyKey,
        accion: 'pagar factura',
      }),

    listarOperadoras: () => pedir('get', '/operadoras', { accion: 'listar operadoras' }),

    recargar: (operadoraId, { numero, monto }, idempotencyKey) =>
      pedir('post', `/operadoras/${encodeURIComponent(operadoraId)}/recargas`, {
        body: { numero, monto },
        idempotencyKey,
        accion: 'recargar',
      }),
  };
}

module.exports = { createProveedoresClient, TIMEOUT_MS };
