// El middleware de validación tiene que dejar el valor ya convertido donde el
// handler lo va a leer.
//
// Existe por un bug real y silencioso: en Express 5 `req.query` es un getter de
// sólo lectura. `req.query = result.data` no lanza error, pero tampoco hace
// nada: el handler seguía recibiendo los strings crudos de la URL. La
// consecuencia visible era que la paginación no funcionaba —pedir `?limit=100`
// devolvía 20 filas igual, porque el service veía el string "100" y caía al
// valor por defecto— y lo mismo pasaba con cualquier `trim` o `default`
// declarado sobre la query.

import { describe, expect, it } from 'vitest';
import express from 'express';
import { z } from 'zod';
import validate from '../../src/middlewares/validate.js';

/** Levanta un servidor mínimo y devuelve lo que el handler vio. */
async function pedir(ruta, { schema, source = 'query' } = {}) {
  const app = express();
  app.use(express.json());
  app.get('/p', validate(schema, source), (req, res) => res.json(req[source]));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

  const server = app.listen(0);
  try {
    const respuesta = await fetch(`http://127.0.0.1:${server.address().port}/p${ruta}`);
    return { status: respuesta.status, body: await respuesta.json() };
  } finally {
    server.close();
  }
}

const paginacion = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .passthrough();

describe('validate sobre la query', () => {
  it('el handler recibe NÚMEROS, no los strings de la URL', async () => {
    const { body } = await pedir('?page=2&limit=100', { schema: paginacion });

    expect(body.limit).toBe(100);
    expect(body.page).toBe(2);
    // Lo que fallaba: con la asignación directa llegaban como "100" y "2".
    expect(typeof body.limit).toBe('number');
  });

  it('aplica los valores por defecto cuando no vienen', async () => {
    const { body } = await pedir('', { schema: paginacion });

    expect(body).toMatchObject({ page: 1, limit: 20 });
  });

  it('sigue rechazando lo inválido', async () => {
    expect((await pedir('?limit=9999', { schema: paginacion })).status).toBe(400);
    expect((await pedir('?limit=-1', { schema: paginacion })).status).toBe(400);
    expect((await pedir('?page=abc', { schema: paginacion })).status).toBe(400);
  });

  it('deja pasar los filtros declarados aparte del esquema', async () => {
    // `passthrough`: los routers suman sus propios filtros, como ?dni=.
    const { body } = await pedir('?limit=5&dni=30111222', { schema: paginacion });

    expect(body.dni).toBe('30111222');
    expect(body.limit).toBe(5);
  });

  it('también aplica las transformaciones, como el trim', async () => {
    const schema = z.object({ alias: z.string().trim().min(1) });
    const { body } = await pedir('?alias=%20%20mi.alias%20%20', { schema });

    expect(body.alias).toBe('mi.alias');
  });

  it('el body sigue funcionando como siempre', async () => {
    const app = express();
    app.use(express.json());
    const schema = z.object({ monto: z.coerce.number() });
    app.post('/p', validate(schema), (req, res) => res.json(req.body));
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/p`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monto: '1500' }),
      });
      expect(await r.json()).toEqual({ monto: 1500 });
    } finally {
      server.close();
    }
  });
});
