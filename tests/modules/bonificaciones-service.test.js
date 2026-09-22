// La bonificación de bienvenida ("órbita secreta"): US$ 5 una sola vez.
//
// Es plata que el banco regala, así que lo que estos tests cuidan es que no se
// pueda cobrar dos veces, ni siquiera con dos pedidos simultáneos, y que si
// algo falla antes de acreditar, no quede marcada como cobrada.

import { describe, it, expect, vi } from 'vitest';

const { createBonificacionesService } = await import('../../src/modules/bonificaciones-service.js');

const USUARIO = { id: 'u1', persona_id: 'p1', roles: ['cliente'] };
const CAJA_USD = { id: 'c-usd', cbu: '0060001944673782002207', numero_cuenta: '081751927997', moneda: 'USD' };

function armar({ yaCobrada = false, insercionDuplicada = false, abrirCuenta } = {}) {
  const pasos = [];

  const query = vi.fn(async (sql, params) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
      pasos.push(sql.toLowerCase());
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT 1 FROM bonificaciones')) {
      return { rows: yaCobrada ? [{}] : [], rowCount: yaCobrada ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO bonificaciones')) {
      if (insercionDuplicada) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      pasos.push('registra');
      return { rows: [{ id: 'b1' }], rowCount: 1 };
    }
    if (sql.includes('FROM tipos_transaccion')) return { rows: [{ id: 'tt-bonif' }], rowCount: 1 };
    if (sql.startsWith('UPDATE cuentas')) {
      pasos.push(['acredita', params[0]]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO transacciones')) {
      pasos.push(['movimiento', params[5]]); // canal
      return { rows: [{ id: 'tx-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const pool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) };
  const abrir = abrirCuenta ?? vi.fn(async () => ({ cuenta: CAJA_USD, creada: true }));

  return {
    servicio: createBonificacionesService({ pool, abrirCuenta: abrir, escribirLogDeAuditoria: vi.fn() }),
    abrir,
    pasos,
  };
}

const acredito = (pasos) => pasos.some((p) => Array.isArray(p) && p[0] === 'acredita');

describe('bonificación de bienvenida', () => {
  it('la primera vez abre la caja en dólares y acredita US$ 5', async () => {
    const { servicio, abrir, pasos } = armar();

    const r = await servicio.otorgarBienvenida({ usuarioActual: USUARIO });

    expect(r).toMatchObject({ monto: 5, moneda: 'USD', cuenta_abierta: true });
    expect(abrir).toHaveBeenCalledWith(expect.objectContaining({ personaId: 'p1', moneda: 'USD' }));
    expect(pasos).toContainEqual(['acredita', '5.00']);
    expect(pasos).toContainEqual(['movimiento', 'bonificacion']);
  });

  it('si ya tenía caja en dólares, acredita ahí sin abrir otra', async () => {
    const { servicio } = armar({ abrirCuenta: vi.fn(async () => ({ cuenta: CAJA_USD, creada: false })) });

    const r = await servicio.otorgarBienvenida({ usuarioActual: USUARIO });

    expect(r.cuenta_abierta).toBe(false);
    expect(r.cuenta.cbu).toBe(CAJA_USD.cbu);
  });

  it('registra la bonificación ANTES de acreditar', async () => {
    // Así, si otro pedido la registró primero, choca antes de tocar el saldo.
    const { servicio, pasos } = armar();
    await servicio.otorgarBienvenida({ usuarioActual: USUARIO });

    const registro = pasos.indexOf('registra');
    const acreditacion = pasos.findIndex((p) => Array.isArray(p) && p[0] === 'acredita');
    expect(registro).toBeGreaterThan(-1);
    expect(registro).toBeLessThan(acreditacion);
  });

  it('una segunda vez da 409 y no abre ni acredita nada', async () => {
    const { servicio, abrir, pasos } = armar({ yaCobrada: true });

    await expect(servicio.otorgarBienvenida({ usuarioActual: USUARIO })).rejects.toMatchObject({ status: 409 });
    expect(abrir).not.toHaveBeenCalled();
    expect(acredito(pasos)).toBe(false);
  });

  it('dos pedidos simultáneos: el que llega segundo choca y no acredita', async () => {
    // Los dos pasan el chequeo previo; la restricción única frena al segundo.
    const { servicio, pasos } = armar({ insercionDuplicada: true });

    await expect(servicio.otorgarBienvenida({ usuarioActual: USUARIO })).rejects.toMatchObject({ status: 409 });
    expect(acredito(pasos)).toBe(false);
    expect(pasos).toContain('rollback');
  });

  it('si no se puede abrir la caja, no queda marcada como cobrada', async () => {
    // Por ejemplo, situación crediticia 3 o peor, o el Central caído: tiene que
    // poder reintentar después.
    const { servicio, pasos } = armar({
      abrirCuenta: vi.fn(async () => {
        throw Object.assign(new Error('Tu situación crediticia no permite abrir cuentas.'), { status: 403 });
      }),
    });

    await expect(servicio.otorgarBienvenida({ usuarioActual: USUARIO })).rejects.toMatchObject({ status: 403 });
    expect(pasos).not.toContain('registra');
    expect(acredito(pasos)).toBe(false);
  });

  it('sin persona identificada, 403', async () => {
    const { servicio } = armar();
    await expect(servicio.otorgarBienvenida({ usuarioActual: { id: 'u1' } })).rejects.toMatchObject({ status: 403 });
  });
});
