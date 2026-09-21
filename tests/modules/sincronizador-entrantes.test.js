// El sincronizador de fondo de transferencias entrantes.
//
// Lo que cuida: que recupere lo atrasado al arrancar, que después consulte con
// la cadencia que recomienda el Central, que un ciclo lento no se superponga
// con el siguiente, y que un Central caído no frene el loop.

import { describe, it, expect, vi, afterEach } from 'vitest';

const { iniciarSincronizadorEntrantes, INTERVALO_MS } = await import('../../src/modules/sincronizador-entrantes.js');

const logger = { info: vi.fn(), warn: vi.fn() };
const vacio = { synced: 0, rechazadas: 0, errors: 0 };

afterEach(() => vi.useRealTimers());

describe('sincronizador de entrantes', () => {
  it('al arrancar mira las últimas 24 horas, el máximo del Central', async () => {
    const sincronizar = vi.fn(async () => vacio);
    const s = iniciarSincronizadorEntrantes({ sincronizar, logger });
    await s.primera;
    s.detener();

    expect(sincronizar).toHaveBeenCalledWith({ minutes: 1440 });
  });

  it('después consulta cada 15 minutos mirando 30 hacia atrás', async () => {
    vi.useFakeTimers();
    const sincronizar = vi.fn(async () => vacio);
    const s = iniciarSincronizadorEntrantes({ sincronizar, logger });
    await s.primera;

    await vi.advanceTimersByTimeAsync(INTERVALO_MS * 2);
    s.detener();

    expect(sincronizar).toHaveBeenCalledTimes(3); // arranque + 2 ciclos
    expect(sincronizar).toHaveBeenLastCalledWith({ minutes: 30 });
  });

  it('un ciclo lento no se superpone con el siguiente', async () => {
    let terminar;
    const sincronizar = vi.fn(() => new Promise((resolve) => { terminar = () => resolve(vacio); }));
    const s = iniciarSincronizadorEntrantes({ sincronizar, logger, intervaloMs: 60_000 });

    // Mientras el primero sigue en curso, pedir otro no dispara nada.
    expect(await s.ciclo(30)).toBeNull();
    expect(sincronizar).toHaveBeenCalledTimes(1);

    terminar();
    await s.primera;
    s.detener();
  });

  it('si el Central no responde, el loop sigue', async () => {
    vi.useFakeTimers();
    const sincronizar = vi
      .fn()
      .mockRejectedValueOnce(new Error('el Central no responde'))
      .mockResolvedValue(vacio);
    const s = iniciarSincronizadorEntrantes({ sincronizar, logger });
    await s.primera;

    await vi.advanceTimersByTimeAsync(INTERVALO_MS);
    s.detener();

    expect(logger.warn).toHaveBeenCalled();
    expect(sincronizar).toHaveBeenCalledTimes(2);
  });
});
