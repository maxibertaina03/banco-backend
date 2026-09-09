// Plazos fijos.
//
// Más simple que los préstamos porque no hay cronograma ni deuda que informar:
// el cliente inmoviliza capital y al vencimiento se le acredita capital más
// interés.
//
// Lo único con matiz es el rescate anticipado: se reconoce sólo el interés de
// los días efectivamente transcurridos, y a la tasa de caja de ahorro, no a la
// pactada. Es la penalidad estándar por romper el plazo.

const realPool = require('../db/pool');
const realMercado = require('./mercado-service');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const { puedeOperarSobrePersona, esUsuarioInterno: esUsuarioInternoLocal } = require('../utils/access-control');
const calculo = require('./calculo-financiero');
const { hoyLocal, sumarDias, aFechaSimple, diasEntre } = require('../utils/fechas');
const movimientos = require('./movimientos');

// Tasa que se reconoce al que rompe el plazo antes de tiempo. Es baja a
// propósito: si el rescate anticipado rindiera igual que el plazo cumplido,
// constituir un plazo fijo no tendría sentido.
const TNA_CANCELACION_ANTICIPADA = 12;

function createPlazosFijosService({
  pool = realPool,
  mercado = realMercado,
  escribirLogDeAuditoria = realEscribirLog,
} = {}) {
  async function enTransaccionDeBd(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await fn(client);
      await client.query('COMMIT');
      return resultado;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function resolverTna(tnaPedida) {
    if (tnaPedida !== null && tnaPedida !== undefined) return Number(tnaPedida);
    const tasas = await mercado.obtenerTasasReferencia();
    if (!tasas?.plazo_fijo?.tna) {
      throw new HttpError(503, 'No hay una tasa de referencia disponible en este momento.');
    }
    return tasas.plazo_fijo.tna;
  }

  async function simular({ capital, dias, tna = null }) {
    return calculo.simularPlazoFijo({ capital, dias, tna: await resolverTna(tna) });
  }

  /** Constituye el plazo fijo: debita el capital y lo inmoviliza. */
  async function constituir({ cuentaId, capital, dias, tna = null, usuarioActual, ipAddress }) {
    const tnaFinal = await resolverTna(tna);
    const simulacion = calculo.simularPlazoFijo({ capital, dias, tna: tnaFinal });

    return enTransaccionDeBd(async (client) => {
      const c = await client.query(
        'SELECT id, persona_id, moneda, saldo, activa FROM cuentas WHERE id = $1 LIMIT 1 FOR UPDATE',
        [cuentaId]
      );
      if (c.rowCount === 0) {
        throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
      }
      const cuenta = c.rows[0];

      if (!cuenta.activa) {
        throw new HttpError(400, 'La cuenta no está activa.');
      }
      if (!puedeOperarSobrePersona(usuarioActual, cuenta.persona_id)) {
        throw new HttpError(403, 'No puedes operar sobre una cuenta que no te pertenece.');
      }

      const capitalExacto = Dinero.desde(simulacion.capital);
      if (capitalExacto.mayorQue(cuenta.saldo)) {
        throw new HttpError(422, 'Saldo insuficiente para constituir el plazo fijo.');
      }

      const fechaConstitucion = hoyLocal();
      const fechaVencimiento = sumarDias(fechaConstitucion, dias);

      const cbuCta = await client.query('SELECT cbu FROM cuentas WHERE id = $1', [cuentaId]);
      await movimientos.debitar(client, {
        cuentaId,
        cbu: cbuCta.rows[0]?.cbu ?? null,
        monto: capitalExacto.aString(),
        tipo: 'plazo_fijo',
        canal: 'plazo_fijo_constitucion',
        descripcion: `Constitución de plazo fijo a ${dias} días`,
      });

      const r = await client.query(
        `INSERT INTO plazos_fijos (
           persona_id, cuenta_id, moneda, capital, dias, tna, interes, total, tea,
           fecha_constitucion, fecha_vencimiento
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          cuenta.persona_id, cuentaId, cuenta.moneda || 'ARS',
          capitalExacto.aString(), dias, tnaFinal,
          Dinero.desde(simulacion.interes).aString(),
          Dinero.desde(simulacion.total).aString(),
          simulacion.tea,
          fechaConstitucion,
          fechaVencimiento,
        ]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'plazos_fijos',
        entidadId: r.rows[0].id,
        payloadDespues: r.rows[0],
        ipAddress,
      });

      return r.rows[0];
    });
  }

  /**
   * Acredita el plazo fijo, al vencimiento o antes.
   *
   * Al vencimiento se paga lo pactado. En el rescate anticipado se recalcula el
   * interés sobre los días transcurridos y a la tasa de caja de ahorro, que es
   * bastante menor: es la penalidad por romper el plazo.
   */
  async function acreditar({ plazoFijoId, anticipada = false, usuarioActual, ipAddress }) {
    return enTransaccionDeBd(async (client) => {
      const r = await client.query('SELECT * FROM plazos_fijos WHERE id = $1 LIMIT 1 FOR UPDATE', [
        plazoFijoId,
      ]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `No existe el plazo fijo con id ${plazoFijoId}.`);
      }
      const pf = r.rows[0];

      if (!puedeOperarSobrePersona(usuarioActual, pf.persona_id)) {
        throw new HttpError(403, 'No puedes operar sobre un plazo fijo que no te pertenece.');
      }
      if (pf.estado === 'acreditado' || pf.estado === 'cancelado_anticipado') {
        throw new HttpError(409, 'El plazo fijo ya estaba cerrado.');
      }

      // `pf.fecha_vencimiento` viene como Date desde pg, no como string:
      // interpolarlo en un template daba una fecha inválida y todo el cálculo
      // terminaba en NaN, que Postgres acepta sin chistar en una columna NUMERIC.
      const hoy = hoyLocal();
      const vencio = aFechaSimple(pf.fecha_vencimiento) <= hoy;

      if (!vencio && !anticipada) {
        throw new HttpError(
          400,
          `El plazo fijo vence el ${pf.fecha_vencimiento}. Para rescatarlo antes hay que pedirlo explícitamente.`
        );
      }

      let totalAcreditar;
      let diasTranscurridos;
      let estadoFinal;

      if (vencio) {
        totalAcreditar = Dinero.desde(pf.total);
        diasTranscurridos = pf.dias;
        estadoFinal = 'acreditado';
      } else {
        diasTranscurridos = diasEntre(aFechaSimple(pf.fecha_constitucion), hoy);
        // Misma fórmula que `simularPlazoFijo`, aplicada a mano: esa función
        // exige un mínimo de 30 días y un rescate puede ocurrir antes.
        const interes = Dinero.desde(pf.capital)
          .por(TNA_CANCELACION_ANTICIPADA / 100)
          .por(diasTranscurridos)
          .dividido(calculo.DIAS_POR_ANIO)
          .redondeado();
        totalAcreditar = Dinero.desde(pf.capital).mas(interes);
        estadoFinal = 'cancelado_anticipado';
      }

      const cbuAcr = await client.query('SELECT cbu FROM cuentas WHERE id = $1', [pf.cuenta_id]);
      await movimientos.acreditar(client, {
        cuentaId: pf.cuenta_id,
        cbu: cbuAcr.rows[0]?.cbu ?? null,
        monto: totalAcreditar.aString(),
        tipo: 'plazo_fijo',
        canal: 'plazo_fijo_acreditacion',
        descripcion: estadoFinal === 'cancelado_anticipado'
          ? `Rescate anticipado de plazo fijo a los ${diasTranscurridos} días`
          : 'Acreditación de plazo fijo al vencimiento',
      });

      const actualizado = await client.query(
        `UPDATE plazos_fijos
            SET estado = $1, fecha_acreditacion = CURRENT_DATE, total_acreditado = $2
          WHERE id = $3 RETURNING *`,
        [estadoFinal, totalAcreditar.aString(), plazoFijoId]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'UPDATE',
        entidad: 'plazos_fijos',
        entidadId: plazoFijoId,
        payloadAntes: pf,
        payloadDespues: actualizado.rows[0],
        ipAddress,
      });

      return {
        plazo_fijo: actualizado.rows[0],
        total_acreditado: totalAcreditar.aNumero(),
        dias_transcurridos: diasTranscurridos,
        anticipada: estadoFinal === 'cancelado_anticipado',
      };
    });
  }

  /** Listado paginado, acotado al usuario si es cliente. */
  async function listar({ usuarioActual, estado = null, page = 1, limit = 20 }) {
    const filtros = [];
    const params = [];

    if (usuarioActual && !esUsuarioInternoLocal(usuarioActual)) {
      params.push(usuarioActual?.persona_id);
      filtros.push(`persona_id = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      filtros.push(`estado = $${params.length}`);
    }

    const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
    params.push(limit, (page - 1) * limit);

    const r = await pool.query(
      `SELECT * FROM plazos_fijos ${where} ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { page, limit, count: r.rows.length, data: r.rows };
  }

  /** Marca como vencidos los que llegaron a su fecha. Es lo que alimenta `?estado=vencido`. */
  async function marcarVencidos() {
    const r = await pool.query(
      `UPDATE plazos_fijos SET estado = 'vencido'
        WHERE estado = 'vigente' AND fecha_vencimiento <= CURRENT_DATE
        RETURNING id`
    );
    return { vencidos: r.rowCount };
  }

  return { simular, constituir, acreditar, listar, marcarVencidos };
}

const servicioPorDefecto = createPlazosFijosService();

module.exports = {
  ...servicioPorDefecto,
  createPlazosFijosService,
  TNA_CANCELACION_ANTICIPADA,
};
