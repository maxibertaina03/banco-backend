import { describe, it, expect } from 'vitest';

const { Dinero } = await import('../../src/utils/dinero.js');

describe('Dinero — construcción', () => {
  it('acepta el string que devuelve NUMERIC de Postgres', () => {
    expect(Dinero.desde('1500.10').aString()).toBe('1500.10');
  });

  it('acepta números y los normaliza a 2 decimales', () => {
    expect(Dinero.desde(1500).aString()).toBe('1500.00');
    expect(Dinero.desde(0.1).aString()).toBe('0.10');
  });

  it('es idempotente sobre otro Dinero', () => {
    const uno = Dinero.desde('42.50');
    expect(Dinero.desde(uno)).toBe(uno);
  });

  it('rechaza valores no numéricos, vacíos y no finitos', () => {
    expect(() => Dinero.desde('abc')).toThrow(TypeError);
    expect(() => Dinero.desde(null)).toThrow(TypeError);
    expect(() => Dinero.desde('')).toThrow(TypeError);
    expect(() => Dinero.desde(Infinity)).toThrow(TypeError);
    expect(() => Dinero.desde(NaN)).toThrow(TypeError);
  });

  it('desdeOpcional devuelve null en vez de tirar', () => {
    expect(Dinero.desdeOpcional(null)).toBeNull();
    expect(Dinero.desdeOpcional(undefined)).toBeNull();
    expect(Dinero.desdeOpcional('')).toBeNull();
    expect(Dinero.desdeOpcional('10.00').aString()).toBe('10.00');
  });
});

describe('Dinero — el problema del float que motivó el value object', () => {
  it('0.1 + 0.2 da exactamente 0.30 (Number da 0.30000000000000004)', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(Dinero.desde('0.1').mas('0.2').aString()).toBe('0.30');
    expect(Dinero.desde('0.1').mas('0.2').igualA('0.3')).toBe(true);
  });

  it('compara por igualdad exacta, sin la tolerancia de 0.001', () => {
    // El caso real: saldoOrigen que manda el cliente vs saldo en la BD.
    expect(Dinero.desde(1500.1).igualA('1500.10')).toBe(true);
    expect(Dinero.desde('1500.10').igualA('1500.11')).toBe(false);
  });

  it('detecta diferencias de un centavo que la tolerancia vieja dejaba pasar', () => {
    // Con `Math.abs(a - b) > 0.001` una diferencia de 0.0005 pasaba como válida.
    expect(Dinero.desde('100.0005').igualA('100.00')).toBe(false);
  });

  it('acumula sumas repetidas sin derivar', () => {
    let total = Dinero.CERO;
    for (let i = 0; i < 1000; i += 1) total = total.mas('0.01');
    expect(total.aString()).toBe('10.00');
  });
});

describe('Dinero — aritmética', () => {
  it('suma, resta, multiplica y divide', () => {
    expect(Dinero.desde('100.00').mas('50.25').aString()).toBe('150.25');
    expect(Dinero.desde('100.00').menos('50.25').aString()).toBe('49.75');
    expect(Dinero.desde('100.00').por(0.06).aString()).toBe('6.00');
    expect(Dinero.desde('100.00').dividido(3).aString()).toBe('33.33');
  });

  it('es inmutable', () => {
    const original = Dinero.desde('100.00');
    original.mas('50.00');
    expect(original.aString()).toBe('100.00');
  });

  it('rechaza la división por cero', () => {
    expect(() => Dinero.desde('100.00').dividido(0)).toThrow(RangeError);
  });

  it('redondea con ROUND_HALF_UP, la convención acordada con los otros bancos', () => {
    expect(Dinero.desde('10.005').redondeado().aString()).toBe('10.01');
    expect(Dinero.desde('10.004').redondeado().aString()).toBe('10.00');
    expect(Dinero.desde('10.015').redondeado().aString()).toBe('10.02');
  });
});

describe('Dinero — comparación', () => {
  it('compara mayor, menor y signo', () => {
    const cien = Dinero.desde('100.00');
    expect(cien.mayorQue('99.99')).toBe(true);
    expect(cien.mayorOIgualA('100.00')).toBe(true);
    expect(cien.menorQue('100.01')).toBe(true);
    expect(cien.esPositivo()).toBe(true);
    expect(Dinero.desde('-1.00').esNegativo()).toBe(true);
    expect(Dinero.CERO.esCero()).toBe(true);
    expect(Dinero.CERO.esPositivo()).toBe(false);
  });
});

describe('Dinero — salida', () => {
  it('aString siempre lleva 2 decimales, para mandar a NUMERIC', () => {
    expect(Dinero.desde(5).aString()).toBe('5.00');
    expect(Dinero.desde('5.1').aString()).toBe('5.10');
  });

  it('aNumero convierte sólo en el borde del contrato externo', () => {
    expect(Dinero.desde('1500.10').aNumero()).toBe(1500.1);
  });

  it('serializa como string en JSON, sin pasar por float', () => {
    expect(JSON.stringify({ saldo: Dinero.desde('1500.10') })).toBe('{"saldo":"1500.10"}');
  });

  it('sobrevive el round-trip string → Dinero → string de importes grandes', () => {
    // NUMERIC(18,2) admite hasta 16 dígitos enteros; un float pierde precisión
    // bastante antes de ese límite.
    const grande = '9999999999999999.99';
    expect(Dinero.desde(grande).aString()).toBe(grande);
  });
});

describe('Dinero — cálculo de préstamos (spec Banco Central v1.1)', () => {
  it('reproduce la cuota del sistema francés del ejemplo acordado', () => {
    // capital 1.000.000, 12 cuotas, TNA 72% → tem 6% → cuota 119.277,03
    const capital = Dinero.desde('1000000');
    const tem = 0.06;
    const n = 12;
    const factor = (1 + tem) ** -n;
    const cuota = capital.por(tem).dividido(1 - factor).redondeado();
    expect(cuota.aString()).toBe('119277.03');
  });

  it('el cronograma cierra en saldo cero exacto', () => {
    const tem = 0.06;
    const cuota = Dinero.desde('119277.03');
    let saldo = Dinero.desde('1000000');

    for (let i = 1; i <= 12; i += 1) {
      const interes = saldo.por(tem).redondeado();
      const amortizacion = i === 12 ? saldo : cuota.menos(interes);
      saldo = saldo.menos(amortizacion);
    }

    expect(saldo.esCero()).toBe(true);
    expect(saldo.aString()).toBe('0.00');
  });

  it('reproduce el interés del plazo fijo del ejemplo acordado', () => {
    // capital 500.000, 30 días, TNA 58%, base 365 → interés 23.835,62
    const interes = Dinero.desde('500000').por(0.58).por(30).dividido(365).redondeado();
    expect(interes.aString()).toBe('23835.62');
  });
});
