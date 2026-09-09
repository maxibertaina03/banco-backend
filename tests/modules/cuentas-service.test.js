// Tests de la apertura de cuentas multi-moneda, con inyección de dependencias.
//
// Lo que más importa acá es el ORDEN: se le pide el CBU al Banco Central antes
// de escribir nada local. Si se invirtiera, un rechazo del Central dejaría
// cuentas locales sin CBU válido, y no habría forma de arreglarlas porque el CBU
// lo genera él.

import { describe, it, expect, vi } from 'vitest';

const { createCuentasService } = await import('../../src/modules/cuentas-service.js');

const PERSONA = { id: 'p1', dni: '30123456', nombre: 'Juan', apellido: 'Pérez' };

/**
 * Arma el service con una base y un Banco Central falsos.
 *
 * @param {object} opciones
 * @param {object|null} opciones.cuentaExistente  Fila que devuelve la búsqueda por moneda.
 * @param {object} opciones.respuestaCentral      Lo que contesta POST /accounts.
 */
function armar({ persona = PERSONA, cuentaExistente = null, respuestaCentral, errorCentral } = {}) {
  const orden = [];

  const client = {
    query: vi.fn(async (sql) => {
      const texto = typeof sql === 'string' ? sql : sql.text;
      if (texto === 'BEGIN' || texto === 'COMMIT' || texto === 'ROLLBACK') return { rows: [] };
      if (texto.includes('FROM tipos_cuenta')) return { rowCount: 1, rows: [{ id: 'tc1' }] };
      if (texto.includes('INSERT INTO cuentas')) {
        orden.push('insert-local');
        return { rowCount: 1, rows: [{ id: 'c-nueva', cbu: '0060001948123456001707', moneda: 'USD' }] };
      }
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql) => {
      if (sql.includes('FROM personas')) {
        return persona ? { rowCount: 1, rows: [persona] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM cuentas')) {
        return cuentaExistente
          ? { rowCount: 1, rows: [cuentaExistente] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
  };

  const abrirCuentaCentral = vi.fn(async () => {
    orden.push('central');
    if (errorCentral) throw errorCentral;
    return respuestaCentral;
  });

  const verificarPuedeOperar = vi.fn(async () => {
    orden.push('riesgo');
    return { verificado: true, situacion: 1 };
  });

  const servicio = createCuentasService({
    pool,
    centralBankService: { abrirCuentaCentral },
    riesgoCrediticio: { verificarPuedeOperar },
    escribirLogDeAuditoria: vi.fn(),
  });

  return { servicio, abrirCuentaCentral, verificarPuedeOperar, client, orden };
}

describe('abrirCuenta — camino feliz', () => {
  it('pide el CBU al Central y recién después escribe local', async () => {
    const { servicio, orden } = armar({
      respuestaCentral: { data: { cbu: '0060001948123456001707', alias: null } },
    });

    const r = await servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' });

    expect(r.creada).toBe(true);
    // El orden es la garantía: riesgo, Central, y sólo entonces la base.
    expect(orden).toEqual(['riesgo', 'central', 'insert-local']);
  });

  it('acepta la respuesta del Central venga envuelta o plana', async () => {
    // `abrirCuentaCentral` usa includeResponseMeta, pero el service tolera las dos.
    for (const respuesta of [
      { data: { cbu: '0060001948123456001707' } },
      { cbu: '0060001948123456001707' },
    ]) {
      const { servicio } = armar({ respuestaCentral: respuesta });
      await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' }))
        .resolves.toMatchObject({ creada: true });
    }
  });
});

describe('abrirCuenta — idempotencia', () => {
  it('devuelve la cuenta existente sin tocar el Central', async () => {
    const { servicio, abrirCuentaCentral, verificarPuedeOperar } = armar({
      cuentaExistente: { id: 'c-vieja', moneda: 'USD', cbu: '0060001948123456001707' },
    });

    const r = await servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' });

    expect(r.creada).toBe(false);
    expect(r.cuenta.id).toBe('c-vieja');
    // No se gasta una request contra el Central ni se re-chequea el riesgo.
    expect(abrirCuentaCentral).not.toHaveBeenCalled();
    expect(verificarPuedeOperar).not.toHaveBeenCalled();
  });
});

describe('abrirCuenta — rechazos', () => {
  it('rechaza una moneda que no acordamos', async () => {
    const { servicio } = armar({ respuestaCentral: {} });
    await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'EUR' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('404 si la persona no existe', async () => {
    const { servicio } = armar({ persona: null, respuestaCentral: {} });
    await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('400 si la persona no tiene DNI, porque el Central lo exige', async () => {
    const { servicio } = armar({ persona: { ...PERSONA, dni: null }, respuestaCentral: {} });
    await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' }))
      .rejects.toThrow(/DNI/);
  });

  it('502 si el Central contesta sin CBU', async () => {
    const { servicio } = armar({ respuestaCentral: { data: { alias: 'algo' } } });
    await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' }))
      .rejects.toMatchObject({ status: 502 });
  });

  it('si el Central falla, no queda una cuenta local a medio crear', async () => {
    const { servicio, client } = armar({ errorCentral: new Error('502 Bad Gateway') });

    await expect(servicio.abrirCuenta({ personaId: 'p1', moneda: 'USD' })).rejects.toThrow();

    // Ni siquiera se abrió la transacción: el Central se consulta antes.
    const inserts = client.query.mock.calls.filter(([sql]) =>
      String(typeof sql === 'string' ? sql : sql.text).includes('INSERT INTO cuentas')
    );
    expect(inserts).toHaveLength(0);
  });
});
