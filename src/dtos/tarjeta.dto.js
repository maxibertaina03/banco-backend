// Mapea filas de `tarjetas` y `autorizaciones` a la representación pública.
//
// Lo importante acá es lo que NO sale: el número completo de la tarjeta se
// guarda en la base porque el sistema tiene que poder validarlo, pero al cliente
// sólo se le muestran los últimos cuatro dígitos. Ese enmascarado vive en este
// único lugar, así que no hay forma de exponerlo por descuido desde otra query.

const { aNumeroDeApi } = require('../utils/dinero');
const { buscarNivel } = require('../modules/niveles-tarjeta');

/** `4506001234567890` → `**** **** **** 7890` */
function enmascarar(numero) {
  if (!numero || numero.length < 4) return '**** **** **** ****';
  return `**** **** **** ${numero.slice(-4)}`;
}

/** `2031-09-08` → `09/31`, que es como se imprime en el plástico. */
function vencimientoCorto(fecha) {
  if (!fecha) return null;
  const d = new Date(fecha);
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const anio = String(d.getUTCFullYear()).slice(-2);
  return `${mes}/${anio}`;
}

function aTarjetaPublica(row) {
  if (!row) return null;
  return {
    id: row.id,
    persona_id: row.persona_id,
    tipo: row.tipo,
    numero_enmascarado: enmascarar(row.numero),
    cuenta_id: row.cuenta_id ?? null,
    limite: aNumeroDeApi(row.limite),
    // El nivel viaja con su nombre y beneficios: la pantalla muestra la tarjeta
    // y su detalle sin tener que repetir el catálogo del banco.
    nivel: row.nivel ?? null,
    nivel_nombre: buscarNivel(row.nivel)?.nombre ?? null,
    beneficios: buscarNivel(row.nivel)?.beneficios ?? null,
    disponible: aNumeroDeApi(row.disponible),
    estado: row.estado,
    vencimiento: vencimientoCorto(row.vencimiento),
    created_at: row.created_at,
  };
}

function aAutorizacionPublica(row) {
  if (!row) return null;
  return {
    id: row.id,
    tarjeta_id: row.tarjeta_id,
    comercio: row.comercio,
    monto: aNumeroDeApi(row.monto),
    cuotas: row.cuotas,
    estado: row.estado,
    motivo_rechazo: row.motivo_rechazo ?? null,
    created_at: row.created_at,
  };
}

module.exports = { aTarjetaPublica, aAutorizacionPublica, enmascarar, vencimientoCorto };
