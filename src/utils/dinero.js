// Value object para importes monetarios.
//
// Por qué existe: `Number` de JavaScript es un float IEEE-754 y no representa
// decimales de forma exacta (`0.1 + 0.2 === 0.30000000000000004`). En un banco
// eso produce saldos que no cierran. El síntoma clásico es tener que comparar
// con tolerancia (`Math.abs(a - b) > 0.001`) en vez de por igualdad.
//
// Dónde está el límite: la aritmética de saldos ocurre en Postgres sobre
// `NUMERIC(18,2)`, que ya es exacta, y `node-postgres` devuelve esas columnas
// como STRING justamente para no perder precisión al convertirlas. El problema
// aparece únicamente cuando ese string pasa por `Number()` en JavaScript.
// Este módulo cubre ese tramo: parsear, comparar y calcular sin salir de
// decimal exacto, y convertir a número sólo en el borde donde un contrato
// externo lo exige.
//
// Convención de redondeo del sistema: 2 decimales, ROUND_HALF_UP. Es la misma
// que se acordó con los demás bancos en la spec del Banco Central v1.1, así
// que las cuotas de préstamos calculadas acá coinciden con las de ellos.

const Decimal = require('decimal.js');

// 28 dígitos significativos: suficiente para (1 + tem)^-n con n hasta 360
// cuotas sin perder precisión en los pasos intermedios.
const DecimalDinero = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9,
  toExpPos: 21,
});

const ESCALA = 2;

/**
 * Valida un factor antes de operar con él.
 *
 * Existe por un incidente real: un `NaN` producto de una fecha mal parseada se
 * propagó por una multiplicación, llegó a `aString()` como la cadena "NaN", y
 * Postgres la aceptó sin error en una columna NUMERIC, dejando el saldo de una
 * cuenta en NaN. Fallar temprano y con un mensaje claro es mucho mejor que
 * escribir basura en la base.
 */
function factorValido(factor, operacion) {
  const numero = Number(factor);
  if (!Number.isFinite(numero)) {
    throw new TypeError(`No se puede ${operacion} por un valor no finito: ${factor}.`);
  }
  return new DecimalDinero(String(factor));
}

class Dinero {
  #valor;

  constructor(valor) {
    this.#valor = valor;
    Object.freeze(this);
  }

  // ── Construcción ──────────────────────────────────────────────────────────

  /**
   * Construye un Dinero a partir de un string (lo que devuelve `NUMERIC` de
   * Postgres), un número, otro Dinero, o un Decimal.
   *
   * Acepta `Number` por compatibilidad con los bodies ya validados por Zod,
   * pero lo convierte vía string para no arrastrar el error del float.
   */
  static desde(valor) {
    if (valor instanceof Dinero) return valor;

    if (valor === null || valor === undefined || valor === '') {
      throw new TypeError('Dinero.desde recibió un valor vacío.');
    }

    if (typeof valor === 'number' && !Number.isFinite(valor)) {
      throw new TypeError(`Dinero.desde recibió un número no finito: ${valor}.`);
    }

    let decimal;
    try {
      decimal = new DecimalDinero(typeof valor === 'number' ? String(valor) : valor);
    } catch {
      throw new TypeError(`Dinero.desde no pudo interpretar el valor: ${JSON.stringify(valor)}.`);
    }

    if (!decimal.isFinite()) {
      throw new TypeError(`Dinero.desde recibió un valor no finito: ${valor}.`);
    }

    return new Dinero(decimal);
  }

  /** Igual que `desde`, pero devuelve `null` en vez de tirar si el valor es nulo. */
  static desdeOpcional(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    return Dinero.desde(valor);
  }

  static get CERO() {
    return new Dinero(new DecimalDinero(0));
  }

  // ── Aritmética ────────────────────────────────────────────────────────────
  // Todas devuelven un Dinero nuevo: la instancia es inmutable.

  mas(otro) {
    return new Dinero(this.#valor.plus(Dinero.desde(otro).#valor));
  }

  menos(otro) {
    return new Dinero(this.#valor.minus(Dinero.desde(otro).#valor));
  }

  /** Multiplica por un factor adimensional (una tasa, un coeficiente). */
  por(factor) {
    return new Dinero(this.#valor.times(factorValido(factor, 'multiplicar')));
  }

  /** Divide por un factor adimensional. */
  dividido(factor) {
    const divisor = factorValido(factor, 'dividir');
    if (divisor.isZero()) {
      throw new RangeError('División por cero en un cálculo de Dinero.');
    }
    return new Dinero(this.#valor.dividedBy(divisor));
  }

  /** Redondea a 2 decimales con ROUND_HALF_UP. */
  redondeado() {
    return new Dinero(this.#valor.toDecimalPlaces(ESCALA, Decimal.ROUND_HALF_UP));
  }

  // ── Comparación ───────────────────────────────────────────────────────────
  // Exactas: no hace falta tolerancia porque no hay error de representación.

  igualA(otro) {
    return this.#valor.equals(Dinero.desde(otro).#valor);
  }

  mayorQue(otro) {
    return this.#valor.greaterThan(Dinero.desde(otro).#valor);
  }

  mayorOIgualA(otro) {
    return this.#valor.greaterThanOrEqualTo(Dinero.desde(otro).#valor);
  }

  menorQue(otro) {
    return this.#valor.lessThan(Dinero.desde(otro).#valor);
  }

  esPositivo() {
    return this.#valor.greaterThan(0);
  }

  esNegativo() {
    return this.#valor.lessThan(0);
  }

  esCero() {
    return this.#valor.isZero();
  }

  // ── Salida ────────────────────────────────────────────────────────────────

  /**
   * Representación exacta con 2 decimales. Es lo que hay que mandar a Postgres
   * y devolver en el API: `node-postgres` acepta el string tal cual para una
   * columna NUMERIC y no lo pasa por float en ningún momento.
   */
  aString() {
    return this.#valor.toDecimalPlaces(ESCALA, Decimal.ROUND_HALF_UP).toFixed(ESCALA);
  }

  /**
   * Convierte a `Number`. Usar SOLO en el borde donde un contrato externo
   * exige un número JSON — hoy, el body que espera el Banco Central
   * (`importe`, `saldoOrigen`). Nunca para cálculos ni comparaciones internas.
   */
  aNumero() {
    return this.#valor.toDecimalPlaces(ESCALA, Decimal.ROUND_HALF_UP).toNumber();
  }

  toJSON() {
    return this.aString();
  }

  toString() {
    return this.aString();
  }

  // Para que `console.log` y los mensajes de error de vitest muestren el valor
  // en vez de `Dinero {}`.
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Dinero(${this.aString()})`;
  }
}

/**
 * Convierte una columna monetaria a número JSON para la respuesta del API.
 *
 * El contrato público expone los importes como number, no como string: el
 * frontend sólo los formatea para mostrar (`formatCurrency`) y no hace
 * aritmética con ellos. Este es el único lugar donde el dinero sale de decimal
 * exacto hacia el cliente, así que si algún día el frontend necesita sumar
 * importes, se cambia acá y en los tipos, no en cada DTO.
 *
 * Devuelve `null` si la columna es nula.
 */
function aNumeroDeApi(valor) {
  const dinero = Dinero.desdeOpcional(valor);
  return dinero === null ? null : dinero.aNumero();
}

module.exports = { Dinero, DecimalDinero, aNumeroDeApi };
