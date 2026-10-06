// El barrido que marca vencidos los QR a los que se les pasó la hora.
//
// No es lo que impide pagar un QR viejo: de eso se ocupa el endpoint de pago,
// que compara contra `expira_at` antes de mover un peso. Esto arregla la foto
// de la base. El estado sólo pasaba a 'vencido' cuando alguien consultaba ese
// cobro, y a un QR que nadie escaneó no lo consulta nadie nunca: quedaba
// 'pendiente' para siempre.

import { describe, expect, it, vi } from 'vitest';
import { iniciarVencedorDeCobros } from '../../src/modules/vencedor-de-cobros.js';

const sinLog = { info: vi.fn(), warn: vi.fn() };

/** Un pool de mentira que anota lo que le pidieron. */
function armarPool({ filas = 0, falla = false } = {}) {
  const consultas = [];
  return {
    consultas,
    query: vi.fn(async (sql) => {
      consultas.push(sql.replace(/\s+/g, ' ').trim());
      if (falla) throw new Error('la base no responde');
      return { rowCount: filas, rows: Array.from({ length: filas }, (_, i) => ({ id: `cobro-${i}` })) };
    }),
  };
}

describe('vencedor de cobros por QR', () => {
  it('sólo toca los pendientes que ya expiraron', async () => {
    const pool = armarPool({ filas: 3 });
    const tarea = iniciarVencedorDeCobros({ pool, logger: sinLog });
    await tarea.primera;
    tarea.detener();

    const sql = pool.consultas[0];
    expect(sql).toMatch(/UPDATE cobros SET estado = 'vencido'/i);
    expect(sql).toMatch(/WHERE estado = 'pendiente' AND expira_at <= NOW\(\)/i);
    // Lo que importa: no puede pisar un cobro ya pagado.
    expect(sql).not.toMatch(/estado = 'pagado'/i);
  });

  it('devuelve cuántos venció', async () => {
    const pool = armarPool({ filas: 3 });
    const tarea = iniciarVencedorDeCobros({ pool, logger: sinLog });
    expect(await tarea.primera).toBe(3);
    tarea.detener();
  });

  it('si la base falla, no explota ni frena el loop', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const pool = armarPool({ falla: true });
    const tarea = iniciarVencedorDeCobros({ pool, logger });

    expect(await tarea.primera).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    // Sigue vivo para el próximo ciclo.
    expect(await tarea.ciclo()).toBeNull();
    tarea.detener();
  });

  it('corre solo cada tanto, sin que nadie lo llame', async () => {
    vi.useFakeTimers();
    try {
      const pool = armarPool({ filas: 0 });
      const tarea = iniciarVencedorDeCobros({ intervaloMs: 1000, pool, logger: sinLog });
      await tarea.primera;
      expect(pool.query).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      expect(pool.query).toHaveBeenCalledTimes(4);
      tarea.detener();

      await vi.advanceTimersByTimeAsync(5000);
      expect(pool.query).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no se superpone consigo mismo si un ciclo tarda', async () => {
    let soltar;
    const pool = {
      query: vi.fn(() => new Promise((resolve) => { soltar = () => resolve({ rowCount: 0, rows: [] }); })),
    };
    const tarea = iniciarVencedorDeCobros({ pool, logger: sinLog });

    // El primero quedó colgado; el segundo no debería ni consultar.
    expect(await tarea.ciclo()).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);

    soltar();
    await tarea.primera;
    tarea.detener();
  });

  it('cuando no hay nada que vencer, no escribe en el log', async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const tarea = iniciarVencedorDeCobros({ pool: armarPool({ filas: 0 }), logger });
    await tarea.primera;
    tarea.detener();

    expect(logger.info).not.toHaveBeenCalled();
  });
});
