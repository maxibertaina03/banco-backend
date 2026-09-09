// Fechas de negocio, sin hora.
//
// Un préstamo se otorga "el 8 de septiembre", no "el 8 de septiembre a las
// 22:14 UTC-3". Las columnas son DATE y el contrato del API declara `format: date`,
// así que todo lo que salga tiene que ser `YYYY-MM-DD` pelado.
//
// Dos trampas que este módulo evita, las dos verificadas en producción:
//
//  1. `new Date().toISOString().slice(0, 10)` devuelve la fecha en **UTC**. A
//     las 22h en Argentina eso ya es el día siguiente, así que un préstamo
//     otorgado el lunes a la noche quedaba fechado el martes.
//
//  2. `node-postgres` convierte una columna DATE en un objeto `Date` a
//     medianoche **local**. Al serializarlo a JSON sale como
//     `2026-10-09T03:00:00.000Z`, que además de feo corre el día para cualquier
//     cliente que lo lea en otra zona.

/** Fecha de hoy en la zona local, como `YYYY-MM-DD`. */
function hoyLocal() {
  const ahora = new Date();
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const dia = String(ahora.getDate()).padStart(2, '0');
  return `${ahora.getFullYear()}-${mes}-${dia}`;
}

/**
 * Normaliza a `YYYY-MM-DD` lo que venga: un `Date` de node-postgres, un string
 * ISO completo, o una fecha ya en el formato correcto.
 *
 * Devuelve `null` para valores vacíos, así el DTO no tiene que preguntarse.
 */
function aFechaSimple(valor) {
  if (!valor) return null;

  if (valor instanceof Date) {
    // Se leen los componentes **locales**: pg armó el Date a medianoche local,
    // así que usar getUTCDate() correría el día.
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }

  return String(valor).slice(0, 10);
}

/** Suma días a una fecha `YYYY-MM-DD`, sin que la hora ni la zona interfieran. */
function sumarDias(fechaSimple, dias) {
  const [anio, mes, dia] = String(fechaSimple).slice(0, 10).split('-').map(Number);
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Días completos entre dos fechas `YYYY-MM-DD`. Nunca negativo.
 * Se opera en UTC a propósito: sin horas de por medio no hay corrimiento.
 */
function diasEntre(desde, hasta) {
  const aUtc = (f) => {
    const [a, m, d] = String(f).slice(0, 10).split('-').map(Number);
    return Date.UTC(a, m - 1, d);
  };
  return Math.max(0, Math.round((aUtc(hasta) - aUtc(desde)) / (24 * 3600 * 1000)));
}

module.exports = { hoyLocal, aFechaSimple, sumarDias, diasEntre };
