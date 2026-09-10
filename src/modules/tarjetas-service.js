// Tarjetas de débito y crédito.
//
// La diferencia entre las dos no es cosmética, cambia contra qué se valida un
// consumo:
//   - Débito  → contra el saldo de la cuenta asociada, y el consumo la debita.
//   - Crédito → contra el límite disponible, y el consumo no toca ninguna cuenta:
//               se paga después, con el resumen.
//
// Toda autorización queda registrada, aprobada o rechazada. Un rechazo es
// información que el cliente necesita ver ("por qué me rebotó la tarjeta") y que
// la auditoría necesita tener, no un evento a descartar.

const realPool = require('../db/pool');
const { escribirLogDeAuditoria: realEscribirLog } = require('../utils/audit');
const { Dinero } = require('../utils/dinero');
const HttpError = require('../utils/http-error');
const { esUsuarioInterno } = require('../utils/access-control');

// Prefijo de los números que emitimos. En un sistema real el BIN lo asigna la
// marca; acá es una convención nuestra que sólo tiene que ser estable.
const BIN = '450600';
const ANIOS_VIGENCIA = 5;

function createTarjetasService({
  pool = realPool,
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

  /** Número de 16 dígitos: BIN + 10 al azar. Único por el constraint de la tabla. */
  function generarNumero() {
    let resto = '';
    for (let i = 0; i < 10; i += 1) resto += Math.floor(Math.random() * 10);
    return `${BIN}${resto}`;
  }

  /**
   * Consumo del período de una tarjeta de crédito.
   *
   * Sólo cuenta las autorizaciones **aprobadas**: una rechazada no consume
   * límite, aunque quede registrada.
   */
  async function consumoDelPeriodo(executor, tarjetaId, desde) {
    const r = await executor.query(
      `SELECT COALESCE(SUM(monto), 0) AS total
         FROM autorizaciones
        WHERE tarjeta_id = $1 AND estado = 'aprobada' AND created_at >= $2`,
      [tarjetaId, desde]
    );
    return Dinero.desde(r.rows[0].total);
  }

  /** Primer día del mes en curso, que es el corte del resumen. */
  function inicioDelPeriodo(fecha = new Date()) {
    return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), 1));
  }

  /** Emite una tarjeta de débito o de crédito. */
  async function emitirTarjeta({ personaId, tipo, cuentaId = null, limite = null, usuarioActual, ipAddress }) {
    if (!['debito', 'credito'].includes(tipo)) {
      throw new HttpError(400, 'El tipo de tarjeta debe ser "debito" o "credito".');
    }

    if (tipo === 'debito') {
      if (!cuentaId) {
        throw new HttpError(400, 'Una tarjeta de débito necesita una cuenta asociada.');
      }
      if (limite !== null) {
        throw new HttpError(400, 'Una tarjeta de débito no lleva límite: debita del saldo de la cuenta.');
      }
    } else {
      if (!limite) {
        throw new HttpError(400, 'Una tarjeta de crédito necesita un límite.');
      }
      if (cuentaId) {
        throw new HttpError(400, 'Una tarjeta de crédito no se ata a una cuenta.');
      }
    }

    let limiteExacto = null;
    if (tipo === 'credito') {
      limiteExacto = Dinero.desde(limite).redondeado();
      if (!limiteExacto.esPositivo()) {
        throw new HttpError(400, 'El límite debe ser mayor a cero.');
      }
    }

    return enTransaccionDeBd(async (client) => {
      const persona = await client.query('SELECT id FROM personas WHERE id = $1 LIMIT 1', [personaId]);
      if (persona.rowCount === 0) {
        throw new HttpError(404, `No existe la persona con id ${personaId}.`);
      }

      if (cuentaId) {
        const cuenta = await client.query(
          'SELECT id, persona_id, activa FROM cuentas WHERE id = $1 LIMIT 1',
          [cuentaId]
        );
        if (cuenta.rowCount === 0) {
          throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
        }
        if (cuenta.rows[0].persona_id !== personaId) {
          throw new HttpError(403, 'La cuenta no pertenece a esa persona.');
        }
        if (!cuenta.rows[0].activa) {
          throw new HttpError(400, 'La cuenta asociada no está activa.');
        }
      }

      const vencimiento = new Date();
      vencimiento.setUTCFullYear(vencimiento.getUTCFullYear() + ANIOS_VIGENCIA);

      // El número es aleatorio y único: se reintenta ante colisión, igual que
      // hace la apertura de cuentas con el CBU.
      let creada = null;
      for (let intento = 0; intento < 5 && !creada; intento += 1) {
        try {
          const r = await client.query(
            `INSERT INTO tarjetas (persona_id, tipo, numero, cuenta_id, limite, vencimiento)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [personaId, tipo, generarNumero(), cuentaId, limiteExacto?.aString() ?? null, vencimiento]
          );
          creada = r.rows[0];
        } catch (error) {
          if (error?.code === '23505') continue;
          throw error;
        }
      }
      if (!creada) {
        throw new HttpError(500, 'No se pudo generar un número de tarjeta único.');
      }

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'tarjetas',
        entidadId: creada.id,
        payloadDespues: creada,
        ipAddress,
      });

      return creada;
    });
  }

  /** Tarjetas de una persona, con el disponible calculado en las de crédito. */
  async function listarPorPersona(personaId) {
    const r = await pool.query(
      'SELECT * FROM tarjetas WHERE persona_id = $1 ORDER BY created_at DESC',
      [personaId]
    );

    const desde = inicioDelPeriodo();
    return Promise.all(
      r.rows.map(async (tarjeta) => {
        if (tarjeta.tipo !== 'credito') return { ...tarjeta, disponible: null };
        const consumido = await consumoDelPeriodo(pool, tarjeta.id, desde);
        return {
          ...tarjeta,
          disponible: Dinero.desde(tarjeta.limite).menos(consumido).aString(),
        };
      })
    );
  }

  /**
   * Autoriza un consumo.
   *
   * Siempre devuelve una autorización registrada, no tira en el rechazo por
   * saldo o límite: el rechazo es un resultado legítimo de la operación, no un
   * error del sistema. El router lo traduce a 201 o 422 según el estado.
   */
  async function autorizarConsumo({ tarjetaId, comercio, monto, cuotas = 1, usuarioActual, ipAddress }) {
    const montoExacto = Dinero.desde(monto).redondeado();
    if (!montoExacto.esPositivo()) {
      throw new HttpError(400, 'El monto del consumo debe ser mayor a cero.');
    }

    return enTransaccionDeBd(async (client) => {
      const r = await client.query('SELECT * FROM tarjetas WHERE id = $1 LIMIT 1 FOR UPDATE', [tarjetaId]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `No existe la tarjeta con id ${tarjetaId}.`);
      }
      const tarjeta = r.rows[0];

      if (!esUsuarioAutorizado(usuarioActual, tarjeta)) {
        throw new HttpError(403, 'No puedes operar sobre una tarjeta que no te pertenece.');
      }

      // Bloqueada o vencida no es "saldo insuficiente": es un estado que
      // impide operar, y merece un 409 en vez de una autorización rechazada.
      if (tarjeta.estado !== 'activa') {
        throw new HttpError(409, `La tarjeta está ${tarjeta.estado}.`);
      }
      if (new Date(tarjeta.vencimiento) < new Date()) {
        throw new HttpError(409, 'La tarjeta está vencida.');
      }

      let motivoRechazo = null;
      let cuentaADebitar = null;

      if (tarjeta.tipo === 'debito') {
        const cuenta = await client.query(
          'SELECT id, saldo, activa FROM cuentas WHERE id = $1 LIMIT 1 FOR UPDATE',
          [tarjeta.cuenta_id]
        );
        if (cuenta.rowCount === 0) {
          throw new HttpError(500, 'La tarjeta apunta a una cuenta que ya no existe.');
        }
        if (!cuenta.rows[0].activa) {
          motivoRechazo = 'La cuenta asociada no está activa.';
        } else if (montoExacto.mayorQue(cuenta.rows[0].saldo)) {
          motivoRechazo = 'Saldo insuficiente en la cuenta asociada.';
        } else {
          cuentaADebitar = cuenta.rows[0].id;
        }
      } else {
        const consumido = await consumoDelPeriodo(client, tarjeta.id, inicioDelPeriodo());
        const disponible = Dinero.desde(tarjeta.limite).menos(consumido);
        if (montoExacto.mayorQue(disponible)) {
          motivoRechazo = `Límite disponible insuficiente. Disponible: ${disponible.aString()}.`;
        }
      }

      if (cuentaADebitar) {
        await client.query('UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2', [
          montoExacto.aString(),
          cuentaADebitar,
        ]);
      }

      const autorizacion = await client.query(
        `INSERT INTO autorizaciones (tarjeta_id, comercio, monto, cuotas, estado, motivo_rechazo)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          tarjeta.id,
          comercio,
          montoExacto.aString(),
          cuotas,
          motivoRechazo ? 'rechazada' : 'aprobada',
          motivoRechazo,
        ]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'CREATE',
        entidad: 'autorizaciones',
        entidadId: autorizacion.rows[0].id,
        payloadDespues: autorizacion.rows[0],
        ipAddress,
      });

      return autorizacion.rows[0];
    });
  }

  /** Bloquea o desbloquea. Una tarjeta vencida no se puede desbloquear. */
  async function cambiarEstado({ tarjetaId, accion, usuarioActual, ipAddress }) {
    if (!['bloquear', 'desbloquear'].includes(accion)) {
      throw new HttpError(400, 'La acción debe ser "bloquear" o "desbloquear".');
    }

    return enTransaccionDeBd(async (client) => {
      const r = await client.query('SELECT * FROM tarjetas WHERE id = $1 LIMIT 1 FOR UPDATE', [tarjetaId]);
      if (r.rowCount === 0) {
        throw new HttpError(404, `No existe la tarjeta con id ${tarjetaId}.`);
      }
      const tarjeta = r.rows[0];

      if (!esUsuarioAutorizado(usuarioActual, tarjeta)) {
        throw new HttpError(403, 'No puedes operar sobre una tarjeta que no te pertenece.');
      }
      if (tarjeta.estado === 'vencida') {
        throw new HttpError(409, 'Una tarjeta vencida no se puede desbloquear ni bloquear.');
      }

      const nuevoEstado = accion === 'bloquear' ? 'bloqueada' : 'activa';
      const actualizada = await client.query(
        'UPDATE tarjetas SET estado = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [nuevoEstado, tarjetaId]
      );

      await escribirLogDeAuditoria(client, {
        usuarioId: usuarioActual?.id,
        accion: 'UPDATE',
        entidad: 'tarjetas',
        entidadId: tarjetaId,
        payloadAntes: tarjeta,
        payloadDespues: actualizada.rows[0],
        ipAddress,
      });

      return actualizada.rows[0];
    });
  }

  /** Resumen mensual. Sólo tiene sentido en crédito. */
  async function obtenerResumen({ tarjetaId, periodo, usuarioActual }) {
    const r = await pool.query('SELECT * FROM tarjetas WHERE id = $1 LIMIT 1', [tarjetaId]);
    if (r.rowCount === 0) {
      throw new HttpError(404, `No existe la tarjeta con id ${tarjetaId}.`);
    }
    const tarjeta = r.rows[0];

    if (!esUsuarioAutorizado(usuarioActual, tarjeta)) {
      throw new HttpError(403, 'No puedes ver el resumen de una tarjeta que no te pertenece.');
    }
    if (tarjeta.tipo !== 'credito') {
      throw new HttpError(400, 'Las tarjetas de débito no tienen resumen: sus consumos van al extracto de la cuenta.');
    }

    const [anio, mes] = (periodo || new Date().toISOString().slice(0, 7)).split('-').map(Number);
    const desde = new Date(Date.UTC(anio, mes - 1, 1));
    const hasta = new Date(Date.UTC(anio, mes, 1));

    const consumos = await pool.query(
      `SELECT * FROM autorizaciones
        WHERE tarjeta_id = $1 AND estado = 'aprobada'
          AND created_at >= $2 AND created_at < $3
        ORDER BY created_at DESC`,
      [tarjetaId, desde, hasta]
    );

    const total = consumos.rows.reduce((acc, c) => acc.mas(c.monto), Dinero.CERO);
    // Pago mínimo: 10 % del total, la convención más común de plaza.
    const pagoMinimo = total.por(0.1).redondeado();

    // Vencimiento: el 10 del mes siguiente al período.
    const vencimiento = new Date(Date.UTC(anio, mes, 10));

    return {
      periodo: `${anio}-${String(mes).padStart(2, '0')}`,
      vencimiento: vencimiento.toISOString().slice(0, 10),
      total_a_pagar: total.aString(),
      pago_minimo: pagoMinimo.aString(),
      consumos: consumos.rows,
    };
  }

  /** Un cliente sólo opera sus tarjetas; los roles internos, cualquiera. */
  function esUsuarioAutorizado(usuarioActual, tarjeta) {
    if (!usuarioActual) return true; // llamada interna sin contexto de usuario
    return esUsuarioInterno(usuarioActual) || tarjeta.persona_id === usuarioActual.persona_id;
  }

  return { emitirTarjeta, listarPorPersona, autorizarConsumo, cambiarEstado, obtenerResumen };
}

const servicioPorDefecto = createTarjetasService();

module.exports = {
  emitirTarjeta: servicioPorDefecto.emitirTarjeta,
  listarPorPersona: servicioPorDefecto.listarPorPersona,
  autorizarConsumo: servicioPorDefecto.autorizarConsumo,
  cambiarEstado: servicioPorDefecto.cambiarEstado,
  obtenerResumen: servicioPorDefecto.obtenerResumen,
  createTarjetasService,
  BIN,
};
