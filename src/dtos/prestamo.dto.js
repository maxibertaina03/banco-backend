// Mapea préstamos, cuotas y plazos fijos a la representación pública.
//
// Los importes salen como number, igual que en el resto del API. Las tasas
// también, pero ojo: la TNA va en PORCENTAJE (72 = 72 %), que es como la
// consume el frontend y como la calcula `calculo-financiero`.

const { aNumeroDeApi } = require('../utils/dinero');
const { aFechaSimple } = require('../utils/fechas');

function aCuotaPublica(row) {
  if (!row) return null;
  return {
    numero: row.numero,
    vencimiento: aFechaSimple(row.vencimiento),
    cuota: aNumeroDeApi(row.cuota),
    capital: aNumeroDeApi(row.capital),
    interes: aNumeroDeApi(row.interes),
    saldo: aNumeroDeApi(row.saldo),
    estado: row.estado ?? undefined,
    fecha_pago: aFechaSimple(row.fecha_pago) ?? undefined,
  };
}

function aPrestamoPublico(row) {
  if (!row) return null;
  const publico = {
    id: row.id,
    persona_id: row.persona_id,
    cuenta_id: row.cuenta_id,
    moneda: row.moneda,
    capital: aNumeroDeApi(row.capital),
    cuotas: row.cuotas,
    tna: row.tna === null || row.tna === undefined ? null : Number(row.tna),
    tem: row.tem === null || row.tem === undefined ? null : Number(row.tem),
    cuota_mensual: aNumeroDeApi(row.cuota_mensual),
    total_a_pagar: aNumeroDeApi(row.total_a_pagar),
    total_intereses: aNumeroDeApi(row.total_intereses),
    cft: row.cft === null || row.cft === undefined ? null : Number(row.cft),
    saldo_deuda: aNumeroDeApi(row.saldo_deuda),
    estado: row.estado,
    fecha_otorgamiento: aFechaSimple(row.fecha_otorgamiento),
    created_at: row.created_at,
  };
  // El cronograma sólo viaja en el detalle, no en los listados: son hasta 72
  // filas por préstamo y engordarían la respuesta sin que nadie las use.
  if (row.cronograma) {
    publico.cronograma = row.cronograma.map(aCuotaPublica);
  }
  return publico;
}

function aPlazoFijoPublico(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona_id: row.persona_id,
    cuenta_id: row.cuenta_id,
    moneda: row.moneda,
    capital: aNumeroDeApi(row.capital),
    dias: row.dias,
    tna: row.tna === null || row.tna === undefined ? null : Number(row.tna),
    interes: aNumeroDeApi(row.interes),
    total: aNumeroDeApi(row.total),
    tea: row.tea === null || row.tea === undefined ? null : Number(row.tea),
    fecha_constitucion: aFechaSimple(row.fecha_constitucion),
    fecha_vencimiento: aFechaSimple(row.fecha_vencimiento),
    estado: row.estado,
    fecha_acreditacion: aFechaSimple(row.fecha_acreditacion),
    total_acreditado: aNumeroDeApi(row.total_acreditado),
    created_at: row.created_at,
  };
}

module.exports = { aPrestamoPublico, aCuotaPublica, aPlazoFijoPublico };
