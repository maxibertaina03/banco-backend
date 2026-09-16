// El manejador de errores, con foco en qué mensaje ve el cliente.
//
// La distinción que importa: un HttpError lo tiramos nosotros con un mensaje
// escrito para el cliente; un Error suelto con status 500 es un bug. En
// producción el segundo se genericiza para no filtrar internos, pero el primero
// no, porque "el proveedor no está disponible, intentá en unos minutos" es
// justamente lo que hay que mostrar, y el contrato lo documenta así.

import { describe, it, expect, vi, afterEach } from 'vitest';

const errorHandler = (await import('../../src/middlewares/error-handler.js')).default;
const HttpError = (await import('../../src/utils/http-error.js')).default;

function responder(error, { produccion = false } = {}) {
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = produccion ? 'production' : 'test';
  vi.resetModules();

  const res = { statusCode: null, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };

  const log = { warn: vi.fn(), error: vi.fn() };
  errorHandler(error, { log, originalUrl: '/api/x' }, res, vi.fn());

  process.env.NODE_ENV = anterior;
  return { ...res, log };
}

afterEach(() => vi.resetModules());

describe('errorHandler', () => {
  it('un 503 nuestro conserva su mensaje y no se loguea como bug', () => {
    const r = responder(new HttpError(503, 'El proveedor no está disponible en este momento.'));

    expect(r.statusCode).toBe(503);
    expect(r.body.error).toBe('El proveedor no está disponible en este momento.');
    expect(r.log.error).not.toHaveBeenCalled();
    expect(r.log.warn).toHaveBeenCalled();
  });

  it('un error inesperado sí se loguea como bug', () => {
    const r = responder(new Error('cannot read property of undefined'));

    expect(r.statusCode).toBe(500);
    expect(r.log.error).toHaveBeenCalled();
  });

  // `isProd` se lee al importar el módulo, así que estos dos casos reimportan
  // con NODE_ENV ya puesto en production.
  async function responderEnProduccion(error) {
    const anterior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const handler = (await import('../../src/middlewares/error-handler.js?prod')).default;

    const res = { statusCode: null, body: null };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    handler(error, { log: { warn: vi.fn(), error: vi.fn() }, originalUrl: '/api/x' }, res, vi.fn());

    process.env.NODE_ENV = anterior;
    return res;
  }

  it('en producción, un 503 nuestro conserva el mensaje para el cliente', async () => {
    const r = await responderEnProduccion(new HttpError(503, 'El proveedor no está disponible en este momento.'));

    expect(r.body.error).toBe('El proveedor no está disponible en este momento.');
  });

  it('en producción, un error inesperado no filtra el detalle interno', async () => {
    const r = await responderEnProduccion(new Error('column "saldo_secreto" does not exist'));

    expect(r.statusCode).toBe(500);
    expect(r.body.error).toBe('Error interno del servidor.');
  });

  it('un 4xx nuestro pasa el mensaje tal cual', () => {
    const r = responder(new HttpError(422, 'Saldo insuficiente para la recarga.'));

    expect(r.statusCode).toBe(422);
    expect(r.body.error).toBe('Saldo insuficiente para la recarga.');
  });
});
