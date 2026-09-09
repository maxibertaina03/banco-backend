// Reportes: resumen de gastos por categoría y exportación de movimientos.
//
// La categoría no es una columna: se deriva del `canal` de la transacción y de
// si la cuenta fue el origen o el destino. Se eligió derivarla en vez de
// guardarla porque el dato ya está y una columna más sería una fuente de
// verdad duplicada que se puede desincronizar.

const realPool = require('../db/pool');
const { Dinero } = require('../utils/dinero');
const { aFechaSimple } = require('../utils/fechas');
const HttpError = require('../utils/http-error');

// De canal a categoría legible. Un mismo canal puede caer en dos categorías
// según la dirección: una transferencia que sale es un gasto, una que entra es
// un ingreso.
const CATEGORIAS = {
  local:                    { sale: 'Transferencias enviadas',  entra: 'Transferencias recibidas' },
  interbancaria_saliente:   { sale: 'Transferencias enviadas',  entra: 'Transferencias recibidas' },
  interbancaria_entrante:   { sale: 'Transferencias enviadas',  entra: 'Transferencias recibidas' },
  deposito_efectivo:        { sale: 'Efectivo',                 entra: 'Depósitos en efectivo' },
  extraccion_efectivo:      { sale: 'Extracciones en efectivo', entra: 'Efectivo' },
  cambio_divisa:            { sale: 'Compra de moneda',         entra: 'Venta de moneda' },
  consumo_tarjeta:          { sale: 'Consumos con tarjeta',     entra: 'Devoluciones' },
  prestamo_acreditado:      { sale: 'Préstamos',                entra: 'Préstamos recibidos' },
  cuota_prestamo:           { sale: 'Cuotas de préstamo',       entra: 'Préstamos' },
  plazo_fijo_constitucion:  { sale: 'Inversiones',              entra: 'Inversiones' },
  plazo_fijo_acreditacion:  { sale: 'Inversiones',              entra: 'Rendimiento de inversiones' },
};

const SIN_CATEGORIA = { sale: 'Otros gastos', entra: 'Otros ingresos' };

/** Categoría de un movimiento, según su canal y su dirección. */
function categoriaDe(canal, entra) {
  const par = CATEGORIAS[canal] || SIN_CATEGORIA;
  return entra ? par.entra : par.sale;
}

function createReportesService({ pool = realPool } = {}) {
  /**
   * Gastos e ingresos del período, agrupados por categoría.
   *
   * Se agrupa en JavaScript y no con un GROUP BY porque la categoría depende de
   * la dirección del movimiento respecto de ESTA cuenta, y eso el SQL no lo sabe
   * sin un CASE que duplicaría la tabla de arriba.
   */
  async function resumenDeGastos({ cuentaId, periodo }) {
    const [anio, mes] = (periodo || new Date().toISOString().slice(0, 7)).split('-').map(Number);
    if (!anio || !mes || mes < 1 || mes > 12) {
      throw new HttpError(400, 'El período va en formato YYYY-MM.');
    }

    const desde = new Date(Date.UTC(anio, mes - 1, 1));
    const hasta = new Date(Date.UTC(anio, mes, 1));

    const r = await pool.query(
      `SELECT canal, monto, cuenta_origen_id, cuenta_destino_id
         FROM transacciones
        WHERE (cuenta_origen_id = $1 OR cuenta_destino_id = $1)
          AND estado = 'completada'
          AND created_at >= $2 AND created_at < $3`,
      [cuentaId, desde, hasta]
    );

    const porCategoria = new Map();
    let totalGastos = Dinero.CERO;
    let totalIngresos = Dinero.CERO;

    for (const fila of r.rows) {
      const entra = fila.cuenta_destino_id === cuentaId;
      const categoria = categoriaDe(fila.canal, entra);
      const monto = Dinero.desde(fila.monto);

      const actual = porCategoria.get(categoria) || { total: Dinero.CERO, cantidad: 0, entra };
      porCategoria.set(categoria, {
        total: actual.total.mas(monto),
        cantidad: actual.cantidad + 1,
        entra,
      });

      if (entra) totalIngresos = totalIngresos.mas(monto);
      else totalGastos = totalGastos.mas(monto);
    }

    const categorias = [...porCategoria.entries()]
      .map(([nombre, d]) => ({
        categoria: nombre,
        tipo: d.entra ? 'ingreso' : 'gasto',
        total: d.total.aNumero(),
        cantidad: d.cantidad,
      }))
      // De mayor a menor: lo primero que quiere ver el cliente es en qué se le
      // va la plata, no el orden alfabético.
      .sort((a, b) => b.total - a.total);

    return {
      periodo: `${anio}-${String(mes).padStart(2, '0')}`,
      total_gastos: totalGastos.aNumero(),
      total_ingresos: totalIngresos.aNumero(),
      balance: totalIngresos.menos(totalGastos).aNumero(),
      categorias,
    };
  }

  /**
   * Movimientos en CSV, listos para descargar.
   *
   * Se escapan las comillas dobles duplicándolas, que es la regla de RFC 4180:
   * una descripción con comillas rompería el archivo en Excel si no.
   */
  async function exportarMovimientos({ cuentaId, desde = null, hasta = null }) {
    const condiciones = ['(cuenta_origen_id = $1 OR cuenta_destino_id = $1)'];
    const params = [cuentaId];

    if (desde) {
      params.push(desde);
      condiciones.push(`created_at >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      condiciones.push(`created_at < $${params.length}`);
    }

    const r = await pool.query(
      `SELECT t.created_at, t.canal, t.monto, t.descripcion, t.estado,
              t.cbu_origen, t.cbu_destino, t.cuenta_destino_id,
              tt.nombre AS tipo
         FROM transacciones t
         LEFT JOIN tipos_transaccion tt ON tt.id = t.tipo_transaccion_id
        WHERE ${condiciones.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC`,
      params
    );

    const escapar = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const cabecera = ['Fecha', 'Tipo', 'Categoria', 'Descripcion', 'Signo', 'Monto', 'Estado'];
    const filas = r.rows.map((f) => {
      const entra = f.cuenta_destino_id === cuentaId;
      return [
        aFechaSimple(f.created_at),
        f.tipo || '',
        categoriaDe(f.canal, entra),
        f.descripcion || '',
        entra ? '+' : '-',
        Dinero.desde(f.monto).aString(),
        f.estado,
      ].map(escapar).join(',');
    });

    return {
      csv: [cabecera.join(','), ...filas].join('\n'),
      filas: filas.length,
    };
  }

  return { resumenDeGastos, exportarMovimientos };
}

const servicioPorDefecto = createReportesService();

module.exports = {
  ...servicioPorDefecto,
  createReportesService,
  categoriaDe,
  CATEGORIAS,
};
