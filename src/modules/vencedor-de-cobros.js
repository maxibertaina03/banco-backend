// Marca vencidos los QR a los que se les pasó la hora.
//
// Un cobro nace con diez minutos de vida. Pasados esos, nadie lo puede pagar:
// el endpoint de pago compara contra `expira_at` antes de mover un peso, así
// que esto NO es lo que impide pagar un QR viejo —eso ya estaba cubierto.
//
// Lo que arregla es la foto de la base. El estado sólo pasaba a 'vencido'
// cuando alguien consultaba ese cobro, y a un QR que nadie escaneó no lo
// consulta nadie nunca: quedaba 'pendiente' para siempre. Cualquier consulta
// de "cuántos cobros están esperando" daba de más, y el índice de pendientes
// se iba llenando de cosas muertas.
//
// Arranca en server.js y no en app.js, para que los tests que importan la app
// no disparen timers.

const realPool = require('../db/pool');
const realLogger = require('../utils/logger');

const INTERVALO_MS = 10 * 60 * 1000;

function iniciarVencedorDeCobros({
  intervaloMs = INTERVALO_MS,
  pool = realPool,
  logger = realLogger,
} = {}) {
  let enCurso = false;

  async function ciclo() {
    // Si un ciclo tarda más que el intervalo, no se superpone con el siguiente.
    if (enCurso) return null;
    enCurso = true;
    try {
      const r = await pool.query(
        `UPDATE cobros SET estado = 'vencido'
          WHERE estado = 'pendiente' AND expira_at <= NOW()
          RETURNING id`
      );
      if (r.rowCount) {
        logger.info({ subsystem: 'cobros', vencidos: r.rowCount }, 'cobros por QR marcados vencidos');
      }
      return r.rowCount;
    } catch (error) {
      // Que no se pueda limpiar no rompe nada: se reintenta en el próximo
      // ciclo, y mientras tanto el pago sigue rechazando los vencidos igual.
      logger.warn({ err: error, subsystem: 'cobros' }, 'no se pudieron vencer los cobros; se reintenta');
      return null;
    } finally {
      enCurso = false;
    }
  }

  const primera = ciclo();
  const timer = setInterval(() => void ciclo(), intervaloMs);
  // No mantiene vivo el proceso por sí solo.
  timer.unref?.();

  return { primera, ciclo, detener: () => clearInterval(timer) };
}

module.exports = { iniciarVencedorDeCobros, INTERVALO_MS };
