// Tests del chequeo crediticio, con inyección de dependencias: vitest no
// intercepta los `require` internos de un módulo CJS, así que el mock del Banco
// Central se pasa por parámetro.
//
// El caso que más importa no es el feliz sino el de la API caída: se decidió
// dejar pasar en vez de bloquear, y eso tiene que estar cubierto para que nadie
// lo "arregle" después sin darse cuenta de que era deliberado.

import { describe, it, expect, vi } from 'vitest';

const { createRiesgoCrediticio, SITUACION_MINIMA_BLOQUEANTE } =
  await import('../../src/modules/riesgo-crediticio.js');

const loggerMudo = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

/** Arma el servicio con un Banco Central que responde lo que se le indique. */
function conCentral(respuesta) {
  const consultarSituacionCrediticia = vi.fn(() =>
    respuesta instanceof Error ? Promise.reject(respuesta) : Promise.resolve(respuesta)
  );
  return {
    servicio: createRiesgoCrediticio({
      centralBankService: { consultarSituacionCrediticia },
      logger: loggerMudo,
    }),
    consultarSituacionCrediticia,
  };
}

describe('consultarSituacion', () => {
  it('mapea la respuesta del Central', async () => {
    const { servicio } = conCentral({
      dni: '30123456',
      situacion: 1,
      deudas: [
        { entidad: 'Banco Nación', monto: 152340.55, situacion: 1 },
        { entidad: 'Banco Galicia', monto: 89000, situacion: 1 },
      ],
    });

    const r = await servicio.consultarSituacion('30123456');
    expect(r.situacion).toBe(1);
    expect(r.descripcion).toBe('Normal');
    expect(r.bancos_acreedores).toBe(2);
  });

  it('trata el DNI sin deudas como situación 1', async () => {
    // El Central devuelve 200 con `deudas: []` para un DNI que no figura,
    // aunque su documentación diga que devuelve 404.
    const { servicio } = conCentral({ dni: '48123456', situacion: 1, deudas: [] });

    const r = await servicio.consultarSituacion('48123456');
    expect(r.situacion).toBe(1);
    expect(r.bancos_acreedores).toBe(0);
  });

  it('no cuenta dos veces al mismo banco', async () => {
    const { servicio } = conCentral({
      situacion: 2,
      deudas: [
        { entidad: 'Banco Nodo', monto: 1000, situacion: 1 },
        { entidad: 'Banco Nodo', monto: 5000, situacion: 2 },
      ],
    });

    expect((await servicio.consultarSituacion('30123456')).bancos_acreedores).toBe(1);
  });

  it('pasa el environment al Banco Central', async () => {
    const { servicio, consultarSituacionCrediticia } = conCentral({ situacion: 1, deudas: [] });
    await servicio.consultarSituacion('30123456', 'test');
    expect(consultarSituacionCrediticia).toHaveBeenCalledWith('30123456', 'test');
  });
});

describe('verificarPuedeOperar', () => {
  it('deja pasar situación 1 y 2', async () => {
    for (const situacion of [1, 2]) {
      const { servicio } = conCentral({ situacion, deudas: [] });
      await expect(servicio.verificarPuedeOperar('30123456', 'abrir la cuenta'))
        .resolves.toEqual({ verificado: true, situacion });
    }
  });

  it('bloquea de situación 3 en adelante, con 403', async () => {
    for (const situacion of [3, 4, 5]) {
      const { servicio } = conCentral({
        situacion,
        deudas: [{ entidad: 'Banco X', monto: 1, situacion }],
      });
      await expect(servicio.verificarPuedeOperar('30123456', 'otorgar el préstamo'))
        .rejects.toMatchObject({ status: 403 });
    }
  });

  it('el mensaje dice qué operación se rechazó y por qué', async () => {
    const { servicio } = conCentral({ situacion: 4, deudas: [] });
    await expect(servicio.verificarPuedeOperar('30123456', 'otorgar el préstamo'))
      .rejects.toThrow(/otorgar el préstamo.*situación 4.*Riesgo alto/);
  });

  it('el umbral acordado es 3', () => {
    expect(SITUACION_MINIMA_BLOQUEANTE).toBe(3);
  });

  it('si el Banco Central falla, DEJA PASAR en vez de bloquear', async () => {
    // Decisión deliberada: la central de deudores es una protección secundaria.
    // Dejar a todos los clientes sin poder operar porque una API de terceros
    // está caída es peor que otorgar un crédito de más.
    const { servicio } = conCentral(new Error('ECONNREFUSED'));

    await expect(servicio.verificarPuedeOperar('30123456', 'abrir la cuenta'))
      .resolves.toEqual({ verificado: false, situacion: null });
  });
});
