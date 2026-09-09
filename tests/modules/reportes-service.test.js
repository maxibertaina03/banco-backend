// Tests de reportes. Lo que más importa es la derivación de categoría: un mismo
// canal cae en categorías distintas según la dirección, y confundirlas haría que
// el cliente vea un ingreso listado como gasto.

import { describe, it, expect, vi } from 'vitest';

const { createReportesService, categoriaDe } = await import('../../src/modules/reportes-service.js');

const CUENTA = 'c-1';

function armar(filas) {
  const pool = { query: vi.fn(async () => ({ rows: filas, rowCount: filas.length })) };
  return createReportesService({ pool });
}

/** Movimiento que ENTRA a la cuenta. */
const entra = (canal, monto, extra = {}) =>
  ({ canal, monto, cuenta_origen_id: null, cuenta_destino_id: CUENTA, estado: 'completada', ...extra });

/** Movimiento que SALE de la cuenta. */
const sale = (canal, monto, extra = {}) =>
  ({ canal, monto, cuenta_origen_id: CUENTA, cuenta_destino_id: null, estado: 'completada', ...extra });

describe('categoriaDe — la dirección cambia la categoría', () => {
  it('una transferencia es gasto si sale e ingreso si entra', () => {
    expect(categoriaDe('local', false)).toBe('Transferencias enviadas');
    expect(categoriaDe('local', true)).toBe('Transferencias recibidas');
  });

  it('el plazo fijo distingue constituir de cobrar', () => {
    expect(categoriaDe('plazo_fijo_constitucion', false)).toBe('Inversiones');
    expect(categoriaDe('plazo_fijo_acreditacion', true)).toBe('Rendimiento de inversiones');
  });

  it('un canal desconocido cae en Otros, sin romper', () => {
    expect(categoriaDe('canal_que_no_existe', false)).toBe('Otros gastos');
    expect(categoriaDe(null, true)).toBe('Otros ingresos');
  });
});

describe('resumenDeGastos', () => {
  it('separa gastos de ingresos y calcula el balance', async () => {
    const s = armar([
      entra('prestamo_acreditado', '200000.00'),
      sale('cuota_prestamo', '39403.49'),
      sale('consumo_tarjeta', '3500.00'),
    ]);

    const r = await s.resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-09' });

    expect(r.total_ingresos).toBe(200000);
    expect(r.total_gastos).toBe(42903.49);
    expect(r.balance).toBe(157096.51);
  });

  it('agrupa varios movimientos de la misma categoría', async () => {
    const s = armar([
      sale('consumo_tarjeta', '1000.00'),
      sale('consumo_tarjeta', '2500.00'),
      sale('consumo_tarjeta', '500.00'),
    ]);

    const r = await s.resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-09' });
    const consumos = r.categorias.find((c) => c.categoria === 'Consumos con tarjeta');

    expect(consumos.total).toBe(4000);
    expect(consumos.cantidad).toBe(3);
  });

  it('ordena de mayor a menor: lo primero es dónde se va la plata', async () => {
    const s = armar([
      sale('consumo_tarjeta', '500.00'),
      sale('cuota_prestamo', '90000.00'),
      sale('local', '3000.00'),
    ]);

    const r = await s.resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-09' });
    expect(r.categorias.map((c) => c.total)).toEqual([90000, 3000, 500]);
  });

  it('un período sin movimientos da todo en cero, no falla', async () => {
    const r = await armar([]).resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-01' });
    expect(r).toMatchObject({ total_gastos: 0, total_ingresos: 0, balance: 0, categorias: [] });
  });

  it('rechaza un período mal formado', async () => {
    await expect(armar([]).resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-13' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('suma sin derivar, aunque haya muchos movimientos chicos', async () => {
    // Cien movimientos de 0,01: con floats el total daría 1.0000000000000007.
    const s = armar(Array.from({ length: 100 }, () => sale('local', '0.01')));
    const r = await s.resumenDeGastos({ cuentaId: CUENTA, periodo: '2026-09' });
    expect(r.total_gastos).toBe(1);
  });
});

describe('exportarMovimientos', () => {
  it('arma un CSV con cabecera y una fila por movimiento', async () => {
    const s = armar([
      sale('consumo_tarjeta', '3500.00', { descripcion: 'Kiosco', tipo: 'consumo_tarjeta', created_at: '2026-09-08' }),
    ]);

    const { csv, filas } = await s.exportarMovimientos({ cuentaId: CUENTA });
    const lineas = csv.split('\n');

    expect(filas).toBe(1);
    expect(lineas[0]).toBe('Fecha,Tipo,Categoria,Descripcion,Signo,Monto,Estado');
    expect(lineas[1]).toContain('Consumos con tarjeta');
    expect(lineas[1]).toContain('-,3500.00');
  });

  it('marca con + lo que entra y con − lo que sale', async () => {
    const s = armar([
      entra('local', '1000.00', { created_at: '2026-09-08' }),
      sale('local', '500.00', { created_at: '2026-09-08' }),
    ]);

    const { csv } = await s.exportarMovimientos({ cuentaId: CUENTA });
    const [, primera, segunda] = csv.split('\n');

    expect(primera).toContain(',+,1000.00');
    expect(segunda).toContain(',-,500.00');
  });

  it('escapa comas y comillas, que romperían el archivo en Excel', async () => {
    const s = armar([
      sale('local', '100.00', {
        descripcion: 'Pago a "El Almacén", sucursal centro',
        created_at: '2026-09-08',
      }),
    ]);

    const { csv } = await s.exportarMovimientos({ cuentaId: CUENTA });
    // La regla de RFC 4180: el campo va entre comillas y las internas se duplican.
    expect(csv).toContain('"Pago a ""El Almacén"", sucursal centro"');
  });
});
