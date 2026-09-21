// Sincronización de transferencias entrantes desde el Banco Central.
//
// Existe por un bug real: `validarEntrante` estaba escrita y testeada, pero la
// sincronización nunca la llamaba. Como el Central no valida monedas, una
// transferencia en pesos a una caja nuestra en dólares se acreditaba 1 a 1
// como dólares. Estos tests recorren la sincronización entera, no la función
// suelta, que es justo lo que antes no se probaba.

import { describe, it, expect, vi } from 'vitest';

const { sincronizarTransaccionesEntrantes } = await import('../../src/modules/central-bank-service.js');

const CUENTA_USD = { id: 'c-usd', cbu: '0060001947667036002005', moneda: 'USD' };

function transferencia(id, cbuOrigen, importe = 100) {
  return { _id: id, estado: 'aprobada', cbuOrigen, cbuDestino: CUENTA_USD.cbu, importe };
}

function armar({ transferencias, monedaDeOrigen = {}, yaRegistradas = [], validacion = null, insercionDuplicada = false }) {
  const escrituras = [];

  const query = vi.fn(async (sql, params) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM cuentas')) return { rows: [CUENTA_USD], rowCount: 1 };
    if (sql.includes('central_transaction_id = ANY')) {
      return { rows: yaRegistradas.map((id) => ({ central_transaction_id: id })), rowCount: yaRegistradas.length };
    }
    if (sql.includes('FROM tipos_transaccion')) return { rows: [{ id: 'tt-transferencia' }], rowCount: 1 };
    if (sql.startsWith('UPDATE cuentas')) {
      escrituras.push(['acredita', params[0]]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO transacciones')) {
      if (insercionDuplicada) {
        // Lo que hace Postgres cuando otra sincronización ya la registró.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      escrituras.push(['registra', params[3], params[7]]); // id del Central, estado
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const db = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) };

  // La validación real, pero con la moneda de origen fijada en el test.
  const validarEntrante = validacion ?? vi.fn(async (cbuOrigen, monedaDestino) => {
    const origen = monedaDeOrigen[cbuOrigen];
    return origen === monedaDestino
      ? { acreditable: true, motivo: null }
      : { acreditable: false, motivo: `El origen es ${origen} y la cuenta de destino es ${monedaDestino}.` };
  });

  return {
    ejecutar: () =>
      sincronizarTransaccionesEntrantes({}, { listar: async () => transferencias, db, validarEntrante }),
    escrituras,
    validarEntrante,
  };
}

describe('sincronización de entrantes', () => {
  it('acredita una transferencia en la misma moneda', async () => {
    const { ejecutar, escrituras } = armar({
      transferencias: [transferencia('tx-usd', 'origen-usd', 0.06)],
      monedaDeOrigen: { 'origen-usd': 'USD' },
    });

    const r = await ejecutar();

    expect(r.synced).toBe(1);
    expect(escrituras).toContainEqual(['acredita', '0.06']);
    expect(escrituras).toContainEqual(['registra', 'tx-usd', 'completada']);
  });

  it('NO acredita pesos en una caja en dólares, y deja constancia', async () => {
    const { ejecutar, escrituras } = armar({
      transferencias: [transferencia('tx-ars', 'origen-ars', 50000)],
      monedaDeOrigen: { 'origen-ars': 'ARS' },
    });

    const r = await ejecutar();

    expect(r.synced).toBe(0);
    expect(r.rechazadas).toBe(1);
    // El saldo no se toca: sin esto, se acreditaban 50.000 dólares.
    expect(escrituras.find(([op]) => op === 'acredita')).toBeUndefined();
    // Pero queda registrada, para que el titular la vea y no se reprocese.
    expect(escrituras).toContainEqual(['registra', 'tx-ars', 'rechazada']);
  });

  it('la validación se consulta con la moneda de la cuenta de destino', async () => {
    const { ejecutar, validarEntrante } = armar({
      transferencias: [transferencia('tx-1', 'origen-usd')],
      monedaDeOrigen: { 'origen-usd': 'USD' },
    });

    await ejecutar();

    expect(validarEntrante).toHaveBeenCalledWith('origen-usd', 'USD', undefined);
  });

  it('si no se puede validar la moneda, no acredita y la deja para la próxima', async () => {
    const { ejecutar, escrituras } = armar({
      transferencias: [transferencia('tx-1', 'x')],
      validacion: vi.fn(async () => {
        throw new Error('el Central no responde');
      }),
    });

    const r = await ejecutar();

    expect(r.errors).toBe(1);
    // Ni acredita ni registra: al no quedar registrada, se reintenta la próxima vez.
    expect(escrituras).toEqual([]);
  });

  it('si otra sincronización la registró al mismo tiempo, no la acredita de nuevo', async () => {
    // Sin el índice único, tres sincronizaciones en paralelo acreditaron la
    // misma transferencia tres veces. Con él, la inserción choca y se deshace.
    const { ejecutar, escrituras } = armar({
      transferencias: [transferencia('tx-concurrente', 'origen-usd')],
      monedaDeOrigen: { 'origen-usd': 'USD' },
      insercionDuplicada: true,
    });

    const r = await ejecutar();

    expect(r.already_recorded).toBe(1);
    expect(r.errors).toBe(0);
    // El registro va antes que el saldo: al chocar, la cuenta ni se toca.
    expect(escrituras.find(([op]) => op === 'acredita')).toBeUndefined();
  });

  it('una transferencia ya registrada no se procesa de nuevo', async () => {
    const { ejecutar, escrituras, validarEntrante } = armar({
      transferencias: [transferencia('tx-vieja', 'origen-usd')],
      monedaDeOrigen: { 'origen-usd': 'USD' },
      yaRegistradas: ['tx-vieja'],
    });

    const r = await ejecutar();

    expect(r.already_recorded).toBe(1);
    expect(validarEntrante).not.toHaveBeenCalled();
    expect(escrituras).toEqual([]);
  });
});
