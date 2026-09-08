// Tests del adapter de mercado. Se centran en la normalización de la TNA, que
// es el punto donde el sistema se rompe en silencio: si `0.19` no se convierte a
// `19`, las cuotas de los préstamos salen cien veces más chicas y el número
// sigue siendo válido, así que nada más lo detecta.

import { describe, it, expect } from 'vitest';

const { aPorcentaje, promediarTna, CASA_DOLAR } = await import('../../src/modules/mercado-service.js');

describe('aPorcentaje — la trampa de la TNA de ArgentinaDatos', () => {
  it('convierte la fracción decimal que publica ArgentinaDatos', () => {
    // Lo que devuelve de verdad la API: 0.19 significa 19 %.
    expect(aPorcentaje(0.19)).toBe(19);
    expect(aPorcentaje(0.65)).toBe(65);
    expect(aPorcentaje(0.045)).toBeCloseTo(4.5, 10);
  });

  it('deja pasar el valor si ya viene en porcentaje', () => {
    // Por si algún día cambian el formato: 72 tiene que seguir siendo 72.
    expect(aPorcentaje(72)).toBe(72);
    expect(aPorcentaje(19)).toBe(19);
  });

  it('acepta strings, que es como a veces llega el JSON', () => {
    expect(aPorcentaje('0.19')).toBe(19);
    expect(aPorcentaje('72')).toBe(72);
  });

  it('descarta valores que no son una tasa', () => {
    expect(aPorcentaje(0)).toBeNull();
    expect(aPorcentaje(-0.5)).toBeNull();
    expect(aPorcentaje(null)).toBeNull();
    expect(aPorcentaje(undefined)).toBeNull();
    expect(aPorcentaje('abc')).toBeNull();
  });

  it('el umbral de 1 es el que desambigua', () => {
    // Justo debajo de 1 se trata como fracción; 1 o más, como porcentaje.
    // Ninguna TNA real de un banco es menor al 1 % anual, así que no hay
    // ambigüedad práctica.
    expect(aPorcentaje(0.99)).toBeCloseTo(99, 10);
    expect(aPorcentaje(1)).toBe(1);
  });
});

describe('promediarTna', () => {
  it('promedia normalizando cada valor primero', () => {
    // Mezcla deliberada de fracciones y porcentajes.
    expect(promediarTna([0.2, 0.4])).toBe(30);
    expect(promediarTna([20, 40])).toBe(30);
    expect(promediarTna([0.2, 40])).toBe(30);
  });

  it('ignora los valores inválidos en vez de arrastrarlos', () => {
    expect(promediarTna([0.2, null, 0, 'abc', 0.4])).toBe(30);
  });

  it('devuelve null si no queda ningún valor usable', () => {
    expect(promediarTna([])).toBeNull();
    expect(promediarTna([0, null, -1])).toBeNull();
  });

  it('redondea a 2 decimales', () => {
    expect(promediarTna([0.1, 0.2, 0.4])).toBe(23.33);
  });
});

describe('mercado-service — configuración', () => {
  it('usa la casa oficial, que es la que acordamos', () => {
    expect(CASA_DOLAR).toBe('oficial');
  });
});

describe('la trampa, contada como cálculo', () => {
  it('sin normalizar, la cuota sale cien veces más chica', async () => {
    const { Dinero } = await import('../../src/utils/dinero.js');

    const capital = Dinero.desde('1000000');
    const cuotas = 12;

    const cuotaCon = (tnaPorcentaje) => {
      const tem = tnaPorcentaje / 12 / 100;
      return capital.por(tem).dividido(1 - (1 + tem) ** -cuotas).redondeado();
    };

    // Lo que devuelve ArgentinaDatos, usado tal cual: TNA de 0.72 %.
    const malo = cuotaCon(0.72);
    // Lo mismo, ya normalizado: TNA de 72 %.
    const bueno = cuotaCon(aPorcentaje(0.72));

    expect(bueno.aString()).toBe('119277.03');
    expect(malo.aString()).toBe('83658.69');

    // El daño real no es que la cuota sea más chica, es que el préstamo se
    // regala: con la TNA sin normalizar el banco cobra 3.904 de interés en un
    // año sobre un millón, en vez de 431.324.
    const interesMalo = malo.por(12).menos(capital);
    const interesBueno = bueno.por(12).menos(capital);
    expect(interesMalo.aString()).toBe('3904.28');
    expect(interesBueno.aString()).toBe('431324.36');
  });
});
