// Tests del cálculo financiero.
//
// Son los tests más importantes del proyecto: acá un error no rompe nada, sólo
// devuelve un número equivocado, y ese número es plata. Además el método está
// acordado con los otros nueve bancos, así que estos tests son la prueba de que
// nuestra simulación coincide con la de ellos.

import { describe, it, expect } from 'vitest';

const calc = await import('../../src/modules/calculo-financiero.js');
const { Dinero } = await import('../../src/utils/dinero.js');

describe('El ejemplo acordado con los otros bancos', () => {
  // Capital 1.000.000, 12 cuotas, TNA 72 % → TEM 6 %.
  // Si algún banco da otro número, el que está mal es el otro.
  const ejemplo = { capital: 1000000, tna: 72, cuotas: 12 };

  it('la cuota es 119.277,03', () => {
    expect(calc.calcularCuota(1000000, 72, 12).aString()).toBe('119277.03');
  });

  it('el total y los intereses coinciden', () => {
    const s = calc.simularPrestamo(ejemplo);
    expect(s.total_a_pagar).toBe(1431324.36);
    expect(s.total_intereses).toBe(431324.36);
  });

  it('el CFT es 101,22 %', () => {
    expect(calc.calcularCft(72)).toBe(101.22);
  });

  it('la primera cuota tiene 60.000 de interés', () => {
    // 1.000.000 × 6 % = 60.000. Es el chequeo más fácil de verificar a mano.
    const { cronograma } = calc.simularPrestamo(ejemplo);
    expect(cronograma[0].interes).toBe('60000.00');
    expect(cronograma[0].capital).toBe('59277.03');
    expect(cronograma[0].saldo).toBe('940722.97');
  });
});

describe('El cronograma cierra en cero exacto', () => {
  // Es la propiedad que más importa: si el saldo final no da cero, quedan
  // centavos que nadie sabe a quién cobrarle.
  const casos = [
    { capital: 1000000, tna: 72, cuotas: 12 },
    { capital: 333333.33, tna: 64.4, cuotas: 7 },   // capital y plazo feos a propósito
    { capital: 1, tna: 100, cuotas: 36 },            // capital mínimo
    { capital: 9999999.99, tna: 0.5, cuotas: 72 },   // capital grande, tasa chica
    { capital: 50000, tna: 0, cuotas: 5 },           // tasa cero
  ];

  it.each(casos)('capital $capital, TNA $tna, $cuotas cuotas', ({ capital, tna, cuotas }) => {
    const { cronograma } = calc.simularPrestamo({ capital, tna, cuotas });

    expect(cronograma).toHaveLength(cuotas);
    expect(cronograma[cronograma.length - 1].saldo).toBe('0.00');
  });

  it.each(casos)('la suma de amortizaciones da el capital: $capital', ({ capital, tna, cuotas }) => {
    const { cronograma } = calc.simularPrestamo({ capital, tna, cuotas });

    const sumaCapital = cronograma.reduce((acc, f) => acc.mas(f.capital), Dinero.CERO);
    expect(sumaCapital.igualA(Dinero.desde(capital).redondeado())).toBe(true);
  });

  it.each(casos)('cada cuota es capital + interés: $capital', ({ capital, tna, cuotas }) => {
    const { cronograma } = calc.simularPrestamo({ capital, tna, cuotas });

    for (const f of cronograma) {
      expect(Dinero.desde(f.capital).mas(f.interes).aString()).toBe(f.cuota);
    }
  });
});

describe('Tasa cero', () => {
  it('reparte el capital en partes iguales, sin intereses', () => {
    const s = calc.simularPrestamo({ capital: 50000, tna: 0, cuotas: 5 });
    expect(s.cuota_mensual).toBe(10000);
    expect(s.total_intereses).toBe(0);
    expect(s.cronograma.every((f) => f.interes === '0.00')).toBe(true);
  });
});

describe('sumarMeses — el desborde de fin de mes', () => {
  it('el 31 de enero más un mes es el 28 de febrero, no el 3 de marzo', () => {
    // `setMonth` de JavaScript desborda solo; si no se corrige, los vencimientos
    // de un préstamo otorgado a fin de mes se van corriendo.
    expect(calc.sumarMeses('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('respeta los años bisiestos', () => {
    expect(calc.sumarMeses('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('el 31 de marzo más un mes es el 30 de abril', () => {
    expect(calc.sumarMeses('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('cruza el año', () => {
    expect(calc.sumarMeses('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('un préstamo a fin de mes no acumula corrimiento', () => {
    // Cada vencimiento se calcula desde la fecha original, no desde el anterior,
    // así que después de febrero vuelve a caer 31.
    const { cronograma } = calc.simularPrestamo({
      capital: 100000, tna: 60, cuotas: 4, fechaOtorgamiento: '2026-01-31',
    });
    expect(cronograma.map((f) => f.vencimiento)).toEqual([
      '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31',
    ]);
  });
});

describe('Plazo fijo — el ejemplo acordado', () => {
  it('500.000 a 30 días con TNA 58 % da 23.835,62 de interés', () => {
    const s = calc.simularPlazoFijo({ capital: 500000, tna: 58, dias: 30 });
    expect(s.interes).toBe(23835.62);
    expect(s.total).toBe(523835.62);
    expect(s.tea).toBe(76.23);
  });

  it('usa base 365, no 360', () => {
    // Con base 360 el interés daría 24.166,67. La diferencia es chica pero
    // sistemática, y es lo que haría que no coincidiéramos con los otros bancos.
    const s = calc.simularPlazoFijo({ capital: 500000, tna: 58, dias: 30 });
    expect(s.interes).not.toBe(24166.67);
  });

  it('a un año, la TEA coincide con la TNA', () => {
    // Sin capitalización intermedia, 365 días de interés simple es la TNA.
    const s = calc.simularPlazoFijo({ capital: 100000, tna: 50, dias: 365 });
    expect(s.interes).toBe(50000);
    expect(s.tea).toBe(50);
  });
});

describe('Validaciones', () => {
  it('rechaza capital cero o negativo', () => {
    expect(() => calc.simularPrestamo({ capital: 0, tna: 50, cuotas: 12 })).toThrow();
    expect(() => calc.simularPrestamo({ capital: -100, tna: 50, cuotas: 12 })).toThrow();
  });

  it('rechaza cuotas fuera de 1 a 72', () => {
    expect(() => calc.simularPrestamo({ capital: 1000, tna: 50, cuotas: 0 })).toThrow();
    expect(() => calc.simularPrestamo({ capital: 1000, tna: 50, cuotas: 73 })).toThrow();
  });

  it('rechaza TNA negativa', () => {
    expect(() => calc.simularPrestamo({ capital: 1000, tna: -5, cuotas: 12 })).toThrow();
  });

  it('rechaza plazos fijos fuera de 30 a 365 días', () => {
    expect(() => calc.simularPlazoFijo({ capital: 1000, tna: 50, dias: 29 })).toThrow();
    expect(() => calc.simularPlazoFijo({ capital: 1000, tna: 50, dias: 366 })).toThrow();
  });
});

describe('situacionPorAtraso — la escala del BCRA', () => {
  it.each([
    [0, 1], [31, 1],
    [32, 2], [90, 2],
    [91, 3], [180, 3],
    [181, 4], [365, 4],
    [366, 5], [1000, 5],
  ])('%i días de atraso → situación %i', (dias, esperada) => {
    expect(calc.situacionPorAtraso(dias)).toBe(esperada);
  });

  it('el umbral de bloqueo cae en 91 días', () => {
    // Situación 3 o peor bloquea abrir cuenta y sacar préstamos.
    expect(calc.situacionPorAtraso(90)).toBeLessThan(3);
    expect(calc.situacionPorAtraso(91)).toBeGreaterThanOrEqual(3);
  });
});

describe('La trampa de la TNA, una vez más', () => {
  it('una TNA sin normalizar regala el préstamo', () => {
    // ArgentinaDatos devuelve 0.72 para el 72 %. Usado tal cual, el banco
    // presta un millón y cobra 3.904 de interés en el año.
    const malo = calc.simularPrestamo({ capital: 1000000, tna: 0.72, cuotas: 12 });
    const bueno = calc.simularPrestamo({ capital: 1000000, tna: 72, cuotas: 12 });

    expect(malo.total_intereses).toBeCloseTo(3904.28, 2);
    expect(bueno.total_intereses).toBe(431324.36);
  });
});
