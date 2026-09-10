// Tests de la validación de monedas.
//
// Este módulo existe porque el Banco Central NO valida monedas: su
// POST /transactions no tiene campo `moneda` y movería el importe tal cual entre
// una caja en pesos y una en dólares. La defensa es nuestra, así que conviene
// tenerla bien cubierta.

import { describe, it, expect, vi } from 'vitest';

const { createMonedas } = await import('../../src/modules/monedas.js');

const loggerMudo = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function armar(respuestaPorCbu) {
  const buscarCuentaPorCbu = vi.fn(async (cbu) => {
    const r = typeof respuestaPorCbu === 'function' ? respuestaPorCbu(cbu) : respuestaPorCbu;
    if (r instanceof Error) throw r;
    return r;
  });
  return {
    servicio: createMonedas({
      centralBankService: { buscarCuentaPorCbu },
      logger: loggerMudo,
    }),
    buscarCuentaPorCbu,
  };
}

describe('resolverMonedaDeCbu', () => {
  it('devuelve la moneda que informa el Banco Central', async () => {
    const { servicio } = armar({ cbu: '1'.repeat(22), moneda: 'USD' });
    expect(await servicio.resolverMonedaDeCbu('1'.repeat(22))).toBe('USD');
  });

  it('cachea: no le pega dos veces al Central por el mismo CBU', async () => {
    const { servicio, buscarCuentaPorCbu } = armar({ moneda: 'ARS' });
    const cbu = '2'.repeat(22);

    await servicio.resolverMonedaDeCbu(cbu);
    await servicio.resolverMonedaDeCbu(cbu);

    expect(buscarCuentaPorCbu).toHaveBeenCalledTimes(1);
  });

  it('devuelve null si el CBU no existe, sin tirar', async () => {
    const noEncontrado = Object.assign(new Error('CBU no encontrado'), { status: 404 });
    const { servicio } = armar(noEncontrado);
    expect(await servicio.resolverMonedaDeCbu('3'.repeat(22))).toBeNull();
    // Un 404 es una respuesta legítima, no un problema: no se loguea como tal.
    expect(loggerMudo.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: 'monedas' }),
      expect.stringContaining('no se pudo resolver')
    );
  });

  it('devuelve null si el Central está caído', async () => {
    const { servicio } = armar(new Error('ECONNREFUSED'));
    expect(await servicio.resolverMonedaDeCbu('4'.repeat(22))).toBeNull();
  });

  it('devuelve null para un CBU vacío sin consultar nada', async () => {
    const { servicio, buscarCuentaPorCbu } = armar({ moneda: 'ARS' });
    expect(await servicio.resolverMonedaDeCbu(null)).toBeNull();
    expect(buscarCuentaPorCbu).not.toHaveBeenCalled();
  });
});

describe('validarMonedasCompatibles — lo que sale', () => {
  it('deja pasar si las dos cuentas son de la misma moneda', async () => {
    const { servicio } = armar({ moneda: 'ARS' });
    await expect(servicio.validarMonedasCompatibles('ARS', '5'.repeat(22)))
      .resolves.toMatchObject({ verificado: true, monedaDestino: 'ARS' });
  });

  it('BLOQUEA pesos hacia dólares, que es el caso que motivó el módulo', async () => {
    const { servicio } = armar({ moneda: 'USD' });
    await expect(servicio.validarMonedasCompatibles('ARS', '6'.repeat(22)))
      .rejects.toMatchObject({ status: 400 });
  });

  it('bloquea también al revés, dólares hacia pesos', async () => {
    const { servicio } = armar({ moneda: 'ARS' });
    await expect(servicio.validarMonedasCompatibles('USD', '7'.repeat(22)))
      .rejects.toMatchObject({ status: 400 });
  });

  it('el mensaje dice las dos monedas y adónde ir', async () => {
    const { servicio } = armar({ moneda: 'USD' });
    await expect(servicio.validarMonedasCompatibles('ARS', '8'.repeat(22)))
      .rejects.toThrow(/origen es ARS.*destino es USD.*compra y venta/s);
  });

  it('trata la moneda ausente como ARS', async () => {
    // Las filas viejas, anteriores a la migración, pueden no traer moneda.
    const { servicio } = armar({ moneda: 'ARS' });
    await expect(servicio.validarMonedasCompatibles(null, '9'.repeat(22)))
      .resolves.toMatchObject({ verificado: true, monedaOrigen: 'ARS' });
  });

  it('si no se pudo verificar el destino, DEJA PASAR', async () => {
    // Misma lógica que el chequeo crediticio: una consulta accesoria caída no
    // puede dejar al banco sin poder transferir.
    const { servicio } = armar(new Error('ECONNREFUSED'));
    await expect(servicio.validarMonedasCompatibles('ARS', '1'.repeat(22)))
      .resolves.toMatchObject({ verificado: false, monedaDestino: null });
  });
});

describe('validarEntrante — lo que llega de otro banco', () => {
  it('acredita si las monedas coinciden', async () => {
    const { servicio } = armar({ moneda: 'ARS' });
    await expect(servicio.validarEntrante('1'.repeat(22), 'ARS'))
      .resolves.toEqual({ acreditable: true, motivo: null });
  });

  it('NO acredita si nos mandan pesos a una cuenta en dólares', async () => {
    // El caso concreto del riesgo: sin esto acreditaríamos 50.000 dólares por
    // una transferencia de 50.000 pesos.
    const { servicio } = armar({ moneda: 'ARS' });
    const r = await servicio.validarEntrante('2'.repeat(22), 'USD');

    expect(r.acreditable).toBe(false);
    expect(r.motivo).toMatch(/origen es ARS.*destino es USD/);
  });

  it('si no se puede verificar el origen, acredita igual', async () => {
    // Es lo que se hacía antes de que existieran las cuentas en dólares, y no
    // se puede rechazar: el dinero ya salió del otro banco.
    const { servicio } = armar(new Error('sin respuesta'));
    await expect(servicio.validarEntrante('3'.repeat(22), 'USD'))
      .resolves.toEqual({ acreditable: true, motivo: null });
  });
});
