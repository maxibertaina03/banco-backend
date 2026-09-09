// Cálculo de préstamos y plazos fijos.
//
// Funciones puras: entran números, salen números. Sin base de datos, sin red,
// sin estado. Eso las hace triviales de testear, que es justo lo que se quiere
// en la parte del sistema donde un error se traduce directo en plata.
//
// ── El método está ACORDADO con los otros nueve bancos ──────────────────────
//
// No es una elección nuestra: si dos bancos calculan distinto, la misma
// simulación da cuotas distintas y el estándar del curso se cae. Las reglas:
//
//   Préstamo — sistema francés, cuota fija:
//     tem   = tna / 12 / 100
//     cuota = capital × tem / (1 − (1 + tem)^−n)
//
//   Plazo fijo — interés simple, base 365:
//     interes = capital × (tna / 100) × (dias / 365)
//
//   Redondeo: 2 decimales, ROUND_HALF_UP, en todos lados.
//   El interés de cada cuota se calcula sobre el SALDO REMANENTE.
//   La ÚLTIMA CUOTA absorbe el residuo para que el saldo cierre exacto en cero.
//
// ── Sobre la TNA ────────────────────────────────────────────────────────────
//
// Siempre en PORCENTAJE (72 significa 72 %). ArgentinaDatos la publica como
// fracción decimal (0.72); `mercado-service` la normaliza antes de que llegue
// acá. Si alguna vez entra sin normalizar, las cuotas salen cien veces más
// chicas y el número sigue siendo válido, así que ningún test lo detecta.

const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');

const MESES_POR_ANIO = 12;
const DIAS_POR_ANIO = 365;

/** Tasa efectiva mensual, en porcentaje. */
function tasaEfectivaMensual(tna) {
  return Number(tna) / MESES_POR_ANIO;
}

/**
 * Cuota fija del sistema francés.
 *
 * @param {Dinero|string|number} capital
 * @param {number} tna     En porcentaje.
 * @param {number} cuotas
 * @returns {Dinero}
 */
function calcularCuota(capital, tna, cuotas) {
  const tem = tasaEfectivaMensual(tna) / 100;

  // Tasa cero: el capital se reparte en partes iguales y no hay interés.
  // Sin este caso la fórmula divide por cero.
  if (tem === 0) {
    return Dinero.desde(capital).dividido(cuotas).redondeado();
  }

  const factor = 1 - (1 + tem) ** -cuotas;
  return Dinero.desde(capital).por(tem).dividido(factor).redondeado();
}

/**
 * Cronograma completo de amortización.
 *
 * La última cuota se arma al revés que las demás: en vez de calcular cuánto
 * capital amortiza, se amortiza **todo el saldo que queda** y la cuota se ajusta
 * a eso. Así los centavos de redondeo acumulados a lo largo del préstamo no
 * dejan un saldo residual de unos pocos centavos que nadie sabría cobrar.
 *
 * @returns {Array<{numero, vencimiento, cuota, capital, interes, saldo}>}
 */
function generarCronograma({ capital, tna, cuotas, fechaOtorgamiento = null }) {
  const tem = tasaEfectivaMensual(tna) / 100;
  const cuotaFija = calcularCuota(capital, tna, cuotas);

  let saldo = Dinero.desde(capital).redondeado();
  const filas = [];

  for (let numero = 1; numero <= cuotas; numero += 1) {
    const interes = saldo.por(tem).redondeado();
    const esUltima = numero === cuotas;

    const amortizacion = esUltima ? saldo : cuotaFija.menos(interes);
    const cuota = esUltima ? amortizacion.mas(interes) : cuotaFija;

    saldo = saldo.menos(amortizacion);

    filas.push({
      numero,
      vencimiento: fechaOtorgamiento ? sumarMeses(fechaOtorgamiento, numero) : null,
      cuota: cuota.aString(),
      capital: amortizacion.aString(),
      interes: interes.aString(),
      saldo: saldo.aString(),
    });
  }

  return filas;
}

/**
 * Suma meses a una fecha, corrigiendo el desborde de fin de mes.
 *
 * El 31 de enero más un mes no es el 3 de marzo: es el 28 o 29 de febrero. El
 * `setMonth` de JavaScript desborda solo, así que hay que corregirlo a mano.
 */
function sumarMeses(fechaISO, meses) {
  const base = new Date(`${String(fechaISO).slice(0, 10)}T00:00:00Z`);
  const dia = base.getUTCDate();
  const resultado = new Date(base);

  resultado.setUTCDate(1);
  resultado.setUTCMonth(resultado.getUTCMonth() + meses);

  const ultimoDiaDelMes = new Date(
    Date.UTC(resultado.getUTCFullYear(), resultado.getUTCMonth() + 1, 0)
  ).getUTCDate();

  resultado.setUTCDate(Math.min(dia, ultimoDiaDelMes));
  return resultado.toISOString().slice(0, 10);
}

/**
 * Costo Financiero Total anual, en porcentaje.
 * Sin cargos adicionales coincide con la TEA: `((1 + tem)^12 − 1) × 100`.
 */
function calcularCft(tna) {
  const tem = tasaEfectivaMensual(tna) / 100;
  return Math.round(((1 + tem) ** MESES_POR_ANIO - 1) * 100 * 100) / 100;
}

/** Simulación completa de un préstamo, sin persistir nada. */
function simularPrestamo({ capital, tna, cuotas, fechaOtorgamiento = null }) {
  if (!(cuotas >= 1 && cuotas <= 72)) {
    throw new HttpError(400, 'La cantidad de cuotas debe estar entre 1 y 72.');
  }
  const capitalExacto = Dinero.desde(capital).redondeado();
  if (!capitalExacto.esPositivo()) {
    throw new HttpError(400, 'El capital debe ser mayor a cero.');
  }
  if (!(Number(tna) >= 0)) {
    throw new HttpError(400, 'La TNA no puede ser negativa.');
  }

  const cronograma = generarCronograma({ capital: capitalExacto, tna, cuotas, fechaOtorgamiento });

  const totalAPagar = cronograma.reduce((acc, f) => acc.mas(f.cuota), Dinero.CERO);
  const totalIntereses = totalAPagar.menos(capitalExacto);

  return {
    capital: capitalExacto.aNumero(),
    cuotas,
    tna: Number(tna),
    tem: Math.round(tasaEfectivaMensual(tna) * 1e6) / 1e6,
    cuota_mensual: calcularCuota(capitalExacto, tna, cuotas).aNumero(),
    total_a_pagar: totalAPagar.aNumero(),
    total_intereses: totalIntereses.aNumero(),
    cft: calcularCft(tna),
    cronograma,
  };
}

/**
 * Simulación de un plazo fijo. Interés simple, base 365.
 *
 * La TEA se calcula capitalizando el rendimiento del período tantas veces como
 * entre en un año: `((1 + tna/100 × dias/365)^(365/dias) − 1) × 100`.
 */
function simularPlazoFijo({ capital, tna, dias }) {
  if (!(dias >= 30 && dias <= 365)) {
    throw new HttpError(400, 'El plazo debe estar entre 30 y 365 días.');
  }
  const capitalExacto = Dinero.desde(capital).redondeado();
  if (!capitalExacto.esPositivo()) {
    throw new HttpError(400, 'El capital debe ser mayor a cero.');
  }

  const interes = capitalExacto
    .por(Number(tna) / 100)
    .por(dias)
    .dividido(DIAS_POR_ANIO)
    .redondeado();

  const rendimiento = (Number(tna) / 100) * (dias / DIAS_POR_ANIO);
  const tea = Math.round(((1 + rendimiento) ** (DIAS_POR_ANIO / dias) - 1) * 100 * 100) / 100;

  return {
    capital: capitalExacto.aNumero(),
    dias,
    tna: Number(tna),
    interes: interes.aNumero(),
    total: capitalExacto.mas(interes).aNumero(),
    tea,
  };
}

/**
 * Situación crediticia según los días de atraso, escala del BCRA.
 * Es la que se informa al Banco Central en el barrido de mora.
 */
function situacionPorAtraso(diasDeAtraso) {
  if (diasDeAtraso <= 31) return 1;
  if (diasDeAtraso <= 90) return 2;
  if (diasDeAtraso <= 180) return 3;
  if (diasDeAtraso <= 365) return 4;
  return 5;
}

module.exports = {
  calcularCuota,
  generarCronograma,
  calcularCft,
  simularPrestamo,
  simularPlazoFijo,
  situacionPorAtraso,
  sumarMeses,
  tasaEfectivaMensual,
  DIAS_POR_ANIO,
};
