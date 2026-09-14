// Préstamos: otorgamiento, pago de cuotas, precancelación y barrido de mora.
//
// El cálculo vive aparte, en `calculo-financiero.js`, que son funciones puras.
// Acá está lo que toca la base y el Banco Central.
//
// ── Lo que hace que la central de deudores sirva ────────────────────────────
//
// Cada préstamo se informa al Banco Central al otorgarse, y su situación se
// actualiza cuando el cliente paga, cancela o entra en mora. Si no informáramos,
// nuestros préstamos no existirían para el resto del sistema financiero y la
// consulta que hacen los otros bancos daría "situación 1" sobre un deudor real.
//
// El caso difícil es el que **deja** de pagar: no dispara ninguna acción, así
// que nada lo detectaría. Para eso está `actualizarMora()`, que se corre desde
// un endpoint interno o un cron externo.

const realPool = require('../db/pool');
const realCentralBankService = require('./central-bank-service');
const realRiesgoCrediticio = require('./riesgo-crediticio');
const realMercado = require('./mercado-service');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const { puedeOperarSobrePersona, esUsuarioInterno: esUsuarioInternoLocal } = require('../utils/access-control');
const calculo = require('./calculo-financiero');
const { hoyLocal } = require('../utils/fechas');
const movimientos = require('./movimientos');

// Una cuota entra en mora a los 31 días corridos del vencimiento. Es la regla
// acordada, y coincide con el umbral de situación 1 del BCRA.
const DIAS_PARA_MORA = 31;

function createPrestamosService({
  pool = realPool,
  centralBankService = realCentralBankService,
  riesgoCrediticio = realRiesgoCrediticio,
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

  /** TNA a usar: la que pidió el banco, o la de referencia del mercado. */
  async function resolverTna(tnaPedida) {
    if (tnaPedida !== null && tnaPedida !== undefined) return Number(tnaPedida);
    const tasas = await mercado.obtenerTasasReferencia();
    if (!tasas?.prestamos?.tna) {
      throw new HttpError(503, 'No hay una tasa de referencia disponible en este momento.');
    }
    return tasas.prestamos.tna;
  }

  /** Simulación, sin persistir. Es lo que alimenta la pantalla del simulador. */
  async function simular({ capital, cuotas, tna = null, fechaOtorgamiento = null }) {
    return calculo.simularPrestamo({
      capital,
      cuotas,
      tna: await resolverTna(tna),
      fechaOtorgamiento,
    });
  }

  /**
   * Otorga el préstamo: acredita el capital, guarda el cronograma e informa la
   * deuda al Banco Central.
   *
   * El chequeo crediticio va primero: situación 3 o peor tira 403 antes de
   * tocar nada.
   */
  async function otorgar({ cuentaId, capital, cuotas, tna = null, fechaOtorgamiento = null, usuarioActual, ipAddress, environment }) {
    const tnaFinal = await resolverTna(tna);
    const fecha = fechaOtorgamiento || hoyLocal();

    const cuenta = await pool.query(
      `SELECT c.id, c.persona_id, c.moneda, c.activa, p.dni
         FROM cuentas c JOIN personas p ON p.id = c.persona_id
        WHERE c.id = $1 LIMIT 1`,
      [cuentaId]
    );
    if (cuenta.rowCount === 0) {
      throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
    }
    const { persona_id: personaId, moneda, activa, dni } = cuenta.rows[0];

    if (!activa) {
      throw new HttpError(400, 'La cuenta no está activa.');
    }
    if (!puedeOperarSobrePersona(usuarioActual, personaId)) {
      throw new HttpError(403, 'No puedes pedir un préstamo sobre una cuenta que no te pertenece.');
    }
    if (!dni) {
      throw new HttpError(400, 'La persona no tiene DNI cargado, y hace falta para informar la deuda.');
    }

    await riesgoCrediticio.verificarPuedeOperar(dni, 'otorgar el préstamo', environment);

    const simulacion = calculo.simularPrestamo({ capital, cuotas, tna: tnaFinal, fechaOtorgamiento: fecha });

    const prestamo = await enTransaccionDeBd(async (client) => {
      const insercion = await client.query(
        `INSERT INTO prestamos (
           persona_id, cuenta_id, moneda, capital, cuotas, tna, tem,
           cuota_mensual, total_a_pagar, total_intereses, cft, saldo_deuda,
           fecha_otorgamiento
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          personaId, cuentaId, moneda,
          Dinero.desde(simulacion.capital).aString(),
          cuotas, tnaFinal, simulacion.tem,
          Dinero.desde(simulacion.cuota_mensual).aString(),
          Dinero.desde(simulacion.total_a_pagar).aString(),
          Dinero.desde(simulacion.total_intereses).aString(),
          simulacion.cft,
          Dinero.desde(simulacion.capital).aString(),
          fecha,
        ]
      );
      const creado = insercion.rows[0];

      // El cronograma se inserta de una sola vez y no cuota por cuota: son hasta
      // 72 filas y no vale la pena hacer 72 round-trips.
      const valores = [];
      const params = [];
      simulacion.cronograma.forEach((f, i) => {
        const base = i * 7;
        valores.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`
        );
        params.push(creado.id, f.numero, f.vencimiento, f.cuota, f.capital, f.interes, f.saldo);
      });
      await client.query(
        `INSERT INTO cuotas_prestamo
           (prestamo_id, numero, vencimiento, cuota, capital, interes, saldo)
         VALUES ${valores.join(',')}`,
        params
      );

      // Acreditar el capital y dejar el movimiento en el extracto: sin esto el
      // cliente ve su saldo saltar sin explicación.
      const cbuCuenta = await client.query('SELECT cbu FROM cuentas WHERE id = $1', [cuentaId]);
      await movimientos.acreditar(client, {
        cuentaId,
        cbu: cbuCuenta.rows[0]?.cbu ?? null,
        monto: Dinero.desde(simulacion.capital).aString(),
        tipo: 'prestamo',
        canal: 'prestamo_acreditado',
        descripcion: `Acreditación de préstamo a ${cuotas} cuotas`,
      });

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'prestamos',
        entidadId: creado.id,
        payloadDespues: creado,
        ipAddress,
      });

      return creado;
    });

    // El informe al Central va DESPUÉS del commit y sin romper la operación si
    // falla: el préstamo ya está otorgado y el dinero acreditado. Si el Central
    // no responde, el barrido de mora lo reinformará más adelante.
    await informarDeudaSinRomper(prestamo, dni, environment);

    return { ...prestamo, cronograma: simulacion.cronograma };
  }

  /** Informa la deuda al Central, dejando warn si falla en vez de tirar. */
  async function informarDeudaSinRomper(prestamo, dni, environment) {
    try {
      await centralBankService.informarDeuda({
        dni,
        monto: Dinero.desde(prestamo.saldo_deuda).aNumero(),
        situacion: prestamo.estado === 'en_mora' ? 3 : 1,
        environment,
      });
      return true;
    } catch {
      // Silencio deliberado: no queremos que una caída del Central impida
      // otorgar un préstamo ya aprobado. El barrido de mora reintenta.
      return false;
    }
  }

  /** Paga la próxima cuota pendiente. No se aceptan pagos parciales ni fuera de orden. */
  async function pagarCuota({ prestamoId, usuarioActual, ipAddress, environment }) {
    const resultado = await enTransaccionDeBd(async (client) => {
      const r = await client.query('SELECT * FROM prestamos WHERE id = $1 LIMIT 1 FOR UPDATE', [prestamoId]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `No existe el préstamo con id ${prestamoId}.`);
      }
      const prestamo = r.rows[0];

      if (!puedeOperarSobrePersona(usuarioActual, prestamo.persona_id)) {
        throw new HttpError(403, 'No puedes pagar un préstamo que no te pertenece.');
      }
      if (prestamo.estado === 'cancelado') {
        throw new HttpError(409, 'El préstamo ya está cancelado.');
      }

      // La próxima pendiente, por número: garantiza el pago en orden.
      const c = await client.query(
        `SELECT * FROM cuotas_prestamo
          WHERE prestamo_id = $1 AND estado <> 'pagada'
          ORDER BY numero ASC LIMIT 1`,
        [prestamoId]
      );
      if (c.rowCount === 0) {
        throw new HttpError(409, 'No quedan cuotas pendientes.');
      }
      const cuota = c.rows[0];
      const montoCuota = Dinero.desde(cuota.cuota);

      const cuenta = await client.query(
        'SELECT id, saldo FROM cuentas WHERE id = $1 LIMIT 1 FOR UPDATE',
        [prestamo.cuenta_id]
      );
      if (montoCuota.mayorQue(cuenta.rows[0].saldo)) {
        throw new HttpError(422, 'Saldo insuficiente para pagar la cuota.');
      }

      const cbuPago = await client.query('SELECT cbu FROM cuentas WHERE id = $1', [prestamo.cuenta_id]);
      await movimientos.debitar(client, {
        cuentaId: prestamo.cuenta_id,
        cbu: cbuPago.rows[0]?.cbu ?? null,
        monto: montoCuota.aString(),
        tipo: 'prestamo',
        canal: 'cuota_prestamo',
        descripcion: `Cuota ${cuota.numero} de ${prestamo.cuotas} del préstamo`,
      });
      await client.query(
        `UPDATE cuotas_prestamo SET estado = 'pagada', fecha_pago = CURRENT_DATE WHERE id = $1`,
        [cuota.id]
      );

      const nuevoSaldo = Dinero.desde(prestamo.saldo_deuda).menos(cuota.capital);
      const pendientes = await client.query(
        `SELECT COUNT(*)::int AS n FROM cuotas_prestamo WHERE prestamo_id = $1 AND estado <> 'pagada'`,
        [prestamoId]
      );
      const quedan = pendientes.rows[0].n;
      const nuevoEstado = quedan === 0 ? 'cancelado' : 'vigente';

      const actualizado = await client.query(
        `UPDATE prestamos SET saldo_deuda = $1, estado = $2, updated_at = NOW()
          WHERE id = $3 RETURNING *`,
        [quedan === 0 ? '0.00' : nuevoSaldo.aString(), nuevoEstado, prestamoId]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'UPDATE',
        entidad: 'prestamos',
        entidadId: prestamoId,
        payloadAntes: prestamo,
        payloadDespues: actualizado.rows[0],
        ipAddress,
      });

      return {
        cuota: { ...cuota, estado: 'pagada' },
        cuotas_pendientes: quedan,
        saldo_deuda: quedan === 0 ? 0 : nuevoSaldo.aNumero(),
        estado_prestamo: nuevoEstado,
        prestamo: actualizado.rows[0],
      };
    });

    await reinformarDeuda(resultado.prestamo, environment);
    return resultado;
  }

  /** Precancela: paga el capital adeudado, sin los intereses de las cuotas futuras. */
  async function precancelar({ prestamoId, usuarioActual, ipAddress, environment }) {
    const resultado = await enTransaccionDeBd(async (client) => {
      const r = await client.query('SELECT * FROM prestamos WHERE id = $1 LIMIT 1 FOR UPDATE', [prestamoId]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `No existe el préstamo con id ${prestamoId}.`);
      }
      const prestamo = r.rows[0];

      if (!puedeOperarSobrePersona(usuarioActual, prestamo.persona_id)) {
        throw new HttpError(403, 'No puedes precancelar un préstamo que no te pertenece.');
      }
      if (prestamo.estado === 'cancelado') {
        throw new HttpError(409, 'El préstamo ya está cancelado.');
      }

      const aPagar = Dinero.desde(prestamo.saldo_deuda);
      const cuenta = await client.query(
        'SELECT id, saldo FROM cuentas WHERE id = $1 LIMIT 1 FOR UPDATE',
        [prestamo.cuenta_id]
      );
      if (aPagar.mayorQue(cuenta.rows[0].saldo)) {
        throw new HttpError(422, `Saldo insuficiente para precancelar. Hacen falta ${aPagar.aString()}.`);
      }

      const cbuPre = await client.query('SELECT cbu FROM cuentas WHERE id = $1', [prestamo.cuenta_id]);
      await movimientos.debitar(client, {
        cuentaId: prestamo.cuenta_id,
        cbu: cbuPre.rows[0]?.cbu ?? null,
        monto: aPagar.aString(),
        tipo: 'prestamo',
        canal: 'cuota_prestamo',
        descripcion: 'Precancelación del préstamo',
      });
      // Las cuotas futuras se marcan pagadas: el capital ya se saldó y sus
      // intereses no se cobran, que es justamente el beneficio de precancelar.
      await client.query(
        `UPDATE cuotas_prestamo SET estado = 'pagada', fecha_pago = CURRENT_DATE
          WHERE prestamo_id = $1 AND estado <> 'pagada'`,
        [prestamoId]
      );

      const actualizado = await client.query(
        `UPDATE prestamos SET saldo_deuda = 0, estado = 'cancelado', updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [prestamoId]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'UPDATE',
        entidad: 'prestamos',
        entidadId: prestamoId,
        payloadAntes: prestamo,
        payloadDespues: actualizado.rows[0],
        ipAddress,
      });

      return { prestamo: actualizado.rows[0], capital_pagado: aPagar.aNumero() };
    });

    await reinformarDeuda(resultado.prestamo, environment);
    return resultado;
  }

  /** Reinforma la deuda al Central, buscando el DNI del titular. */
  async function reinformarDeuda(prestamo, environment) {
    const p = await pool.query('SELECT dni FROM personas WHERE id = $1 LIMIT 1', [prestamo.persona_id]);
    if (p.rowCount === 0 || !p.rows[0].dni) return false;
    return informarDeudaSinRomper(prestamo, p.rows[0].dni, environment);
  }

  /**
   * Barrido de mora. Es la pieza que hace que la central de deudores sirva de
   * verdad: el cliente que deja de pagar no dispara nada, así que sin esto el
   * Banco Central seguiría informando situación 1 sobre alguien que hace medio
   * año no aparece.
   *
   * Se dispara desde `POST /api/prestamos/actualizar-mora`, a mano o por cron
   * externo. Se eligió endpoint y no `setInterval` porque se puede testear y
   * porque no se duplica si corren dos instancias del backend.
   *
   * @returns {Promise<{revisados, en_mora, informados, errores}>}
   */
  async function actualizarMora({ environment } = {}) {
    // Cuotas vencidas e impagas, con los días de atraso ya calculados por la
    // base, que es quien tiene la fecha de verdad.
    const vencidas = await pool.query(
      `SELECT c.prestamo_id,
              MAX((CURRENT_DATE - c.vencimiento)::int) AS dias_atraso
         FROM cuotas_prestamo c
         JOIN prestamos p ON p.id = c.prestamo_id
        WHERE c.estado <> 'pagada'
          AND c.vencimiento < CURRENT_DATE - $1::int
          AND p.estado <> 'cancelado'
        GROUP BY c.prestamo_id`,
      [DIAS_PARA_MORA]
    );

    const resumen = { revisados: vencidas.rowCount, en_mora: 0, informados: 0, errores: 0 };

    for (const fila of vencidas.rows) {
      const situacion = calculo.situacionPorAtraso(fila.dias_atraso);

      const p = await pool.query(
        `UPDATE prestamos SET estado = 'en_mora', updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [fila.prestamo_id]
      );
      await pool.query(
        `UPDATE cuotas_prestamo SET estado = 'en_mora'
          WHERE prestamo_id = $1 AND estado = 'pendiente' AND vencimiento < CURRENT_DATE - $2::int`,
        [fila.prestamo_id, DIAS_PARA_MORA]
      );
      resumen.en_mora += 1;

      const persona = await pool.query('SELECT dni FROM personas WHERE id = $1 LIMIT 1', [
        p.rows[0].persona_id,
      ]);
      if (!persona.rows[0]?.dni) continue;

      try {
        await centralBankService.informarDeuda({
          dni: persona.rows[0].dni,
          monto: Dinero.desde(p.rows[0].saldo_deuda).aNumero(),
          situacion,
          environment,
        });
        resumen.informados += 1;
      } catch {
        resumen.errores += 1;
      }
    }

    return resumen;
  }

  /** Detalle con el cronograma completo. */
  async function obtenerPorId({ prestamoId, usuarioActual }) {
    const r = await pool.query('SELECT * FROM prestamos WHERE id = $1 LIMIT 1', [prestamoId]);
    if (r.rowCount === 0) {
      throw new HttpError(404, `No existe el préstamo con id ${prestamoId}.`);
    }
    const prestamo = r.rows[0];

    if (!puedeOperarSobrePersona(usuarioActual, prestamo.persona_id)) {
      throw new HttpError(403, 'No puedes ver un préstamo que no te pertenece.');
    }

    const cuotas = await pool.query(
      'SELECT * FROM cuotas_prestamo WHERE prestamo_id = $1 ORDER BY numero ASC',
      [prestamoId]
    );
    return { ...prestamo, cronograma: cuotas.rows };
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
      `SELECT * FROM prestamos ${where} ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { page, limit, count: r.rows.length, data: r.rows };
  }

  return { simular, otorgar, pagarCuota, precancelar, actualizarMora, obtenerPorId, listar };
}

const servicioPorDefecto = createPrestamosService();

module.exports = {
  ...servicioPorDefecto,
  createPrestamosService,
  DIAS_PARA_MORA,
};
