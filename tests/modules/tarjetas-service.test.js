// Tests de tarjetas, con inyección de dependencias.
//
// El caso que más cuidado merece es el rechazo: una autorización rechazada por
// saldo o límite **no es un error**, es un resultado legítimo que tiene que
// quedar registrado con su motivo. Si se tirara una excepción, el rechazo se
// perdería y el cliente nunca sabría por qué le rebotó la tarjeta.

import { describe, it, expect, vi } from 'vitest';

const { createTarjetasService, BIN } = await import('../../src/modules/tarjetas-service.js');

const CREDITO = {
  id: 't-cred', persona_id: 'p1', tipo: 'credito', numero: '4506001111111111',
  cuenta_id: null, limite: '500000.00', estado: 'activa',
  vencimiento: new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000),
};
const DEBITO = {
  id: 't-deb', persona_id: 'p1', tipo: 'debito', numero: '4506002222222222',
  cuenta_id: 'c-ars', limite: null, estado: 'activa',
  vencimiento: new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000),
};

/**
 * @param {object} o
 * @param {object} o.tarjeta   Fila que devuelve el SELECT de tarjetas.
 * @param {string} o.consumido Total ya consumido en el período (crédito).
 * @param {object} o.cuenta    Cuenta asociada (débito).
 */
function armar({ tarjeta = CREDITO, consumido = '0', cuenta = { id: 'c-ars', saldo: '100000.00', activa: true } } = {}) {
  const escrituras = [];

  const client = {
    query: vi.fn(async (sql, params) => {
      const t = typeof sql === 'string' ? sql : sql.text;
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) return { rows: [], rowCount: 0 };
      if (t.includes('FROM tarjetas')) return { rows: [tarjeta], rowCount: 1 };
      if (t.includes('FROM personas')) return { rows: [{ id: 'p1' }], rowCount: 1 };
      if (t.includes('FROM cuentas')) return { rows: [cuenta], rowCount: cuenta ? 1 : 0 };
      if (t.includes('SUM(monto)')) return { rows: [{ total: consumido }], rowCount: 1 };
      if (t.includes('UPDATE cuentas')) { escrituras.push(['debito-cuenta', params[0]]); return { rows: [], rowCount: 1 }; }
      if (t.includes('INSERT INTO autorizaciones')) {
        escrituras.push(['autorizacion', params[4]]);
        return { rows: [{ id: 'a1', tarjeta_id: tarjeta.id, monto: params[2], estado: params[4], motivo_rechazo: params[5] }], rowCount: 1 };
      }
      if (t.includes('INSERT INTO tarjetas')) {
        return { rows: [{ id: 't-nueva', numero: params[2], tipo: params[1], limite: params[4] }], rowCount: 1 };
      }
      if (t.includes('UPDATE tarjetas')) return { rows: [{ ...tarjeta, estado: params[0] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = { connect: vi.fn(async () => client), query: client.query };
  return { servicio: createTarjetasService({ pool, escribirLogDeAuditoria: vi.fn() }), client, escrituras };
}

describe('emitirTarjeta — las reglas de coherencia', () => {
  it('rechaza una de débito sin cuenta', async () => {
    const { servicio } = armar();
    await expect(servicio.emitirTarjeta({ personaId: 'p1', tipo: 'debito' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rechaza una de crédito sin límite', async () => {
    const { servicio } = armar();
    await expect(servicio.emitirTarjeta({ personaId: 'p1', tipo: 'credito' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rechaza una de crédito atada a una cuenta', async () => {
    const { servicio } = armar();
    await expect(servicio.emitirTarjeta({ personaId: 'p1', tipo: 'credito', limite: 100000, cuentaId: 'c-ars' }))
      .rejects.toThrow(/no se ata a una cuenta/);
  });

  it('emite una de crédito con el BIN acordado', async () => {
    const { servicio } = armar();
    const t = await servicio.emitirTarjeta({ personaId: 'p1', tipo: 'credito', limite: 500000 });
    expect(t.numero).toMatch(new RegExp(`^${BIN}\\d{10}$`));
    expect(t.numero).toHaveLength(16);
  });

  it('rechaza si la cuenta es de otra persona', async () => {
    const { servicio } = armar({ cuenta: { id: 'c-ars', persona_id: 'p2', activa: true } });
    await expect(servicio.emitirTarjeta({ personaId: 'p1', tipo: 'debito', cuentaId: 'c-ars' }))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe('autorizarConsumo — crédito', () => {
  it('aprueba si entra en el límite', async () => {
    const { servicio } = armar({ consumido: '100000' });
    const a = await servicio.autorizarConsumo({ tarjetaId: 't-cred', comercio: 'Super', monto: 50000 });
    expect(a.estado).toBe('aprobada');
    expect(a.motivo_rechazo).toBeNull();
  });

  it('RECHAZA sin tirar, y deja el motivo, si no entra en el límite', async () => {
    // 400.000 ya consumidos de 500.000: quedan 100.000 y se piden 150.000.
    const { servicio } = armar({ consumido: '400000' });
    const a = await servicio.autorizarConsumo({ tarjetaId: 't-cred', comercio: 'Super', monto: 150000 });

    expect(a.estado).toBe('rechazada');
    expect(a.motivo_rechazo).toMatch(/Límite disponible insuficiente.*100000\.00/);
  });

  it('el consumo de crédito no toca ninguna cuenta', async () => {
    const { servicio, escrituras } = armar({ consumido: '0' });
    await servicio.autorizarConsumo({ tarjetaId: 't-cred', comercio: 'Super', monto: 1000 });
    expect(escrituras.find(([tipo]) => tipo === 'debito-cuenta')).toBeUndefined();
  });
});

describe('autorizarConsumo — débito', () => {
  it('aprueba y debita la cuenta asociada', async () => {
    const { servicio, escrituras } = armar({ tarjeta: DEBITO });
    const a = await servicio.autorizarConsumo({ tarjetaId: 't-deb', comercio: 'Kiosco', monto: 5000 });

    expect(a.estado).toBe('aprobada');
    expect(escrituras).toContainEqual(['debito-cuenta', '5000.00']);
  });

  it('rechaza si no alcanza el saldo, y no debita nada', async () => {
    const { servicio, escrituras } = armar({
      tarjeta: DEBITO,
      cuenta: { id: 'c-ars', saldo: '1000.00', activa: true },
    });
    const a = await servicio.autorizarConsumo({ tarjetaId: 't-deb', comercio: 'Kiosco', monto: 5000 });

    expect(a.estado).toBe('rechazada');
    expect(a.motivo_rechazo).toMatch(/Saldo insuficiente/);
    expect(escrituras.find(([tipo]) => tipo === 'debito-cuenta')).toBeUndefined();
  });
});

describe('autorizarConsumo — estados que impiden operar', () => {
  it('409 si la tarjeta está bloqueada, no una autorización rechazada', async () => {
    // Bloqueada no es "sin saldo": es un estado que impide la operación, y
    // merece un error distinto para que el cliente entienda qué pasó.
    const { servicio } = armar({ tarjeta: { ...CREDITO, estado: 'bloqueada' } });
    await expect(servicio.autorizarConsumo({ tarjetaId: 't-cred', comercio: 'X', monto: 100 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('409 si está vencida', async () => {
    const { servicio } = armar({ tarjeta: { ...CREDITO, vencimiento: new Date('2020-01-01') } });
    await expect(servicio.autorizarConsumo({ tarjetaId: 't-cred', comercio: 'X', monto: 100 }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('403 si la tarjeta es de otro cliente', async () => {
    const { servicio } = armar();
    await expect(servicio.autorizarConsumo({
      tarjetaId: 't-cred', comercio: 'X', monto: 100,
      usuarioActual: { persona_id: 'p2' },
    })).rejects.toMatchObject({ status: 403 });
  });
});

describe('cambiarEstado', () => {
  it('bloquea y desbloquea', async () => {
    const { servicio } = armar();
    expect((await servicio.cambiarEstado({ tarjetaId: 't-cred', accion: 'bloquear' })).estado).toBe('bloqueada');
    expect((await servicio.cambiarEstado({ tarjetaId: 't-cred', accion: 'desbloquear' })).estado).toBe('activa');
  });

  it('no se puede desbloquear una vencida', async () => {
    const { servicio } = armar({ tarjeta: { ...CREDITO, estado: 'vencida' } });
    await expect(servicio.cambiarEstado({ tarjetaId: 't-cred', accion: 'desbloquear' }))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('obtenerResumen', () => {
  it('las de débito no tienen resumen', async () => {
    const { servicio } = armar({ tarjeta: DEBITO });
    await expect(servicio.obtenerResumen({ tarjetaId: 't-deb' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
