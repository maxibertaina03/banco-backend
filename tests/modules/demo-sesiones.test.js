// El borrado de una sesión de prueba.
//
// La consigna dice que al cerrar la sesión se borre todo lo que el visitante
// hizo. Borrar la persona NO alcanza: la cascada muere contra `bonificaciones`
// (RESTRICT), `transacciones` (NO ACTION), `cobros` (RESTRICT) y las claves de
// préstamos y plazos fijos hacia `cuentas` (RESTRICT). Por eso hay un orden, y
// por eso hay un test que lo vigila: si alguien lo altera, en producción el
// cierre empieza a fallar con un error de clave foránea y las sesiones se
// quedan para siempre.

import { describe, it, expect, vi } from 'vitest';

const { createDemoService, hashDeToken, PREFIJO_TOKEN } = await import('../../src/modules/demo-service.js');

const sinLog = { info: vi.fn(), warn: vi.fn() };

/** Un pool de mentira que anota, en orden, cada tabla que se borra. */
function armarPool({ personaBorrada = 1 } = {}) {
  const borrados = [];
  const sentencias = [];

  const query = vi.fn(async (sqlCrudo, params) => {
    const sql = String(sqlCrudo).replace(/\s+/g, ' ').trim();
    sentencias.push(sql);
    const m = sql.match(/^DELETE FROM (\w+)/i);
    if (m) borrados.push(m[1]);
    if (/^DELETE FROM personas/i.test(sql)) {
      return { rowCount: personaBorrada, rows: personaBorrada ? [{ id: params[0] }] : [] };
    }
    return { rowCount: 0, rows: [] };
  });

  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query }, borrados, sentencias, client };
}

const posicion = (borrados, tabla) => borrados.indexOf(tabla);

describe('borrar una sesión de prueba', () => {
  it('borra en un orden que no choca con ninguna clave foránea', async () => {
    const { pool, borrados } = armarPool();
    await createDemoService({ pool, logger: sinLog }).borrarSesion('persona-demo');

    // Las cuatro que bloquean el borrado de `cuentas`.
    for (const tabla of ['cobros', 'bonificaciones', 'transacciones', 'prestamos', 'plazos_fijos']) {
      expect(posicion(borrados, tabla), `${tabla} tiene que ir antes que cuentas`)
        .toBeLessThan(posicion(borrados, 'cuentas'));
    }
    // Y `cuentas` antes que `personas`, que es la que cascadea el resto.
    expect(posicion(borrados, 'cuentas')).toBeLessThan(posicion(borrados, 'personas'));
    expect(posicion(borrados, 'personas')).toBe(borrados.length - 1);
  });

  it('todo va en una sola transacción', async () => {
    const { pool, sentencias } = armarPool();
    await createDemoService({ pool, logger: sinLog }).borrarSesion('persona-demo');

    expect(sentencias[0]).toBe('BEGIN');
    expect(sentencias.at(-1)).toBe('COMMIT');
  });

  it('si algo falla, hace ROLLBACK y no deja media sesión borrada', async () => {
    const { pool, sentencias, client } = armarPool();
    client.query.mockImplementation(async (sql) => {
      const texto = String(sql).replace(/\s+/g, ' ').trim();
      sentencias.push(texto);
      if (/DELETE FROM transacciones/i.test(texto)) throw new Error('la base se cayó');
      return { rowCount: 0, rows: [] };
    });

    await expect(
      createDemoService({ pool, logger: sinLog }).borrarSesion('persona-demo')
    ).rejects.toThrow('la base se cayó');

    expect(sentencias).toContain('ROLLBACK');
    expect(sentencias).not.toContain('COMMIT');
  });

  it('NUNCA borra una persona que no sea de prueba', async () => {
    // El seguro: aunque a esta función le llegue el id de un cliente real, el
    // WHERE lo deja afuera. Es la última línea de defensa si algún día alguien
    // llama a borrarSesion con el id equivocado.
    const { pool, sentencias } = armarPool({ personaBorrada: 0 });
    const borradas = await createDemoService({ pool, logger: sinLog }).borrarSesion('persona-real');

    const borradoDePersona = sentencias.find((s) => /^DELETE FROM personas/i.test(s));
    expect(borradoDePersona).toMatch(/es_demo = TRUE/i);
    expect(borradas).toBe(0);
  });

  it('el token se guarda hasheado, nunca en claro', async () => {
    const token = `${PREFIJO_TOKEN}abc123`;
    const hash = hashDeToken(token);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain('abc123');
    // Determinista: el mismo token siempre da el mismo hash, que es lo que
    // permite buscarlo sin guardarlo.
    expect(hashDeToken(token)).toBe(hash);
  });
});

describe('barrer las sesiones vencidas', () => {
  it('borra una por una las que ya expiraron', async () => {
    const vencidas = [{ persona_id: 'p1' }, { persona_id: 'p2' }];
    let primera = true;
    const query = vi.fn(async (sql, params) => {
      const texto = String(sql).replace(/\s+/g, ' ').trim();
      if (/FROM demo_sesiones/i.test(texto) && primera) {
        primera = false;
        return { rowCount: 2, rows: vencidas };
      }
      if (/^DELETE FROM personas/i.test(texto)) return { rowCount: 1, rows: [{ id: params[0] }] };
      return { rowCount: 0, rows: [] };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }), query };

    const borradas = await createDemoService({ pool, logger: sinLog }).barrerVencidas();

    expect(borradas).toBe(2);
    // Sólo mira las que no están cerradas y ya vencieron.
    const seleccion = query.mock.calls.map(([s]) => String(s).replace(/\s+/g, ' ')).find((s) => /FROM demo_sesiones/i.test(s));
    expect(seleccion).toMatch(/cerrada_at IS NULL/i);
    expect(seleccion).toMatch(/expira_at <= NOW\(\)/i);
  });
});
