// Datos de mercado: cotización del dólar y tasas de referencia.
//
// Es la única puerta de entrada del backend a datos financieros de afuera. El
// resto del código pide `obtenerCotizacionDolar()` y no sabe que atrás hay una
// API pública que se puede caer.
//
// Fuentes, decididas con Gonza y verificadas con curl antes de escribir esto:
//   - Cotización → DolarAPI, casa `oficial`.
//   - Tasas      → ArgentinaDatos (plazo fijo y préstamos personales).
//   - BCRA quedó DESCARTADA: el path del Régimen de Transparencia devuelve 404
//     y sus endpoints de estadísticas dan 410 Gone. ArgentinaDatos cubre lo mismo.
//
// ⚠️ LA TRAMPA DE LA TNA. ArgentinaDatos publica las tasas como **fracción
// decimal**: `tna: 0.19` significa 19 %. Nuestra fórmula del sistema francés y
// todo `Dinero` trabajan en **porcentaje**. Si no se normaliza acá, las cuotas
// salen cien veces más chicas y ningún test lo caza, porque el número sigue
// siendo válido. Por eso la normalización vive en un solo lugar: esta función.

const { createTTLCache } = require('../utils/ttl-cache');
const { traer } = require('./mercado/mercado-client');

const URL_DOLAR = 'https://dolarapi.com/v1/dolares';
const URL_PLAZO_FIJO = 'https://api.argentinadatos.com/v1/finanzas/tasas/plazoFijo';
const URL_PRESTAMOS = 'https://api.argentinadatos.com/v1/finanzas/creditos/prestamosPersonales';

// La casa que usamos para comprar y vender dólares. Decisión de equipo: si mañana
// se pasa a `blue` o `mayorista`, se cambia esta constante y nada más.
const CASA_DOLAR = 'oficial';

// La cotización se mueve durante el día pero no cada segundo: 10 minutos alcanza
// y evita pegarle a DolarAPI en cada compra.
const cacheCotizacion = createTTLCache(4, 10 * 60_000);
// Las tasas de referencia cambian por día, así que una hora es holgado.
const cacheTasas = createTTLCache(4, 60 * 60_000);

/**
 * Convierte la TNA de ArgentinaDatos a porcentaje.
 *
 * Publican `0.19` para una tasa del 19 %. El umbral de 1 desambigua sin
 * hardcodear: ninguna TNA real de un banco argentino es menor al 1 % anual, y
 * ninguna fracción decimal de una tasa razonable llega a 1. Si algún día
 * publican `19` directo, el valor pasa derecho sin tocarse.
 */
function aPorcentaje(tna) {
  const valor = Number(tna);
  if (!Number.isFinite(valor) || valor <= 0) return null;
  return valor < 1 ? valor * 100 : valor;
}

/**
 * Cotización oficial del dólar.
 *
 * @returns {Promise<{moneda, casa, compra, venta, fecha_actualizacion, desde_respaldo}>}
 */
async function obtenerCotizacionDolar() {
  const cacheada = cacheCotizacion.get(CASA_DOLAR);
  if (cacheada) return cacheada;

  const { datos, desdeRespaldo } = await traer('dolar', URL_DOLAR);

  const casa = Array.isArray(datos) ? datos.find((d) => d?.casa === CASA_DOLAR) : null;
  if (!casa) {
    throw new Error(`DolarAPI no devolvió la casa "${CASA_DOLAR}".`);
  }

  const cotizacion = {
    moneda: 'USD',
    casa: CASA_DOLAR,
    compra: Number(casa.compra),
    venta: Number(casa.venta),
    fecha_actualizacion: casa.fechaActualizacion ?? null,
    desde_respaldo: desdeRespaldo,
  };

  // El respaldo no se cachea: si la API está caída queremos reintentar en la
  // próxima llamada, no quedarnos diez minutos con un valor viejo.
  if (!desdeRespaldo) cacheCotizacion.set(CASA_DOLAR, cotizacion);
  return cotizacion;
}

/**
 * Promedio de las TNA que publican los bancos, ya en porcentaje.
 * Se usa el promedio y no el máximo para no quedar pegados al outlier de turno.
 */
function promediarTna(valores) {
  const limpios = valores.map(aPorcentaje).filter((v) => v !== null);
  if (limpios.length === 0) return null;
  const suma = limpios.reduce((acc, v) => acc + v, 0);
  return Math.round((suma / limpios.length) * 100) / 100;
}

/**
 * Tasas de referencia del mercado, **en porcentaje**.
 *
 * @returns {Promise<{prestamos: {tna}, plazo_fijo: {tna}, actualizado_al, desde_respaldo}>}
 */
async function obtenerTasasReferencia() {
  const cacheadas = cacheTasas.get('referencia');
  if (cacheadas) return cacheadas;

  const [pf, pp] = await Promise.all([
    traer('plazo-fijo', URL_PLAZO_FIJO),
    traer('prestamos', URL_PRESTAMOS),
  ]);

  const desdeRespaldo = pf.desdeRespaldo || pp.desdeRespaldo;

  const tnaPlazoFijo = promediarTna(
    (Array.isArray(pf.datos) ? pf.datos : []).map((b) => b?.tnaClientes).filter(Boolean)
  );
  const tnaPrestamos = promediarTna(
    (Array.isArray(pp.datos) ? pp.datos : []).map((e) => e?.tna).filter(Boolean)
  );

  const tasas = {
    prestamos: { tna: tnaPrestamos },
    plazo_fijo: { tna: tnaPlazoFijo },
    actualizado_al: new Date().toISOString(),
    desde_respaldo: desdeRespaldo,
  };

  if (!desdeRespaldo) cacheTasas.set('referencia', tasas);
  return tasas;
}

/** Sólo para tests: fuerza que la próxima llamada vaya a la API. */
function _limpiarCache() {
  cacheCotizacion.clear();
  cacheTasas.clear();
}

module.exports = {
  obtenerCotizacionDolar,
  obtenerTasasReferencia,
  aPorcentaje,
  promediarTna,
  _limpiarCache,
  CASA_DOLAR,
};
