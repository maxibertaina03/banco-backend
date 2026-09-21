// Trae solas, de fondo, las transferencias que otros bancos nos mandan.
//
// El Banco Central no avisa: hay que preguntarle. Y su `GET /transactions` sólo
// mira hasta 24 horas atrás, así que una sincronización que dependa de que
// alguien abra el portal pierde para siempre lo que llegó hace más de un día.
// Por eso corre en el servidor, con la cadencia que el propio Central
// recomienda en su documentación: cada 15 minutos, mirando 30 hacia atrás. La
// superposición entre ventanas es a propósito: el índice único por
// transferencia hace que repetir sea seguro.
//
// Arranca en server.js y no en app.js, para que los tests que importan la app
// no disparen timers.

const realCentralBankService = require('./central-bank-service');
const realLogger = require('../utils/logger');

const INTERVALO_MS = 15 * 60 * 1000;
const VENTANA_MINUTOS = 30;
// Al arrancar, la ventana máxima que acepta el Central: recupera lo que llegó
// mientras el servidor estuvo apagado, hasta 24 horas.
const VENTANA_INICIAL_MINUTOS = 1440;

function iniciarSincronizadorEntrantes({
  intervaloMs = INTERVALO_MS,
  sincronizar = (opciones) => realCentralBankService.sincronizarTransaccionesEntrantes(opciones),
  logger = realLogger,
} = {}) {
  let enCurso = false;

  async function ciclo(minutes) {
    // Si un ciclo tarda más que el intervalo, no se superpone con el siguiente.
    if (enCurso) return null;
    enCurso = true;
    try {
      const r = await sincronizar({ minutes });
      if (r.synced || r.rechazadas || r.errors) {
        logger.info(
          { subsystem: 'sincronizador', acreditadas: r.synced, rechazadas: r.rechazadas, errores: r.errors },
          'transferencias entrantes sincronizadas'
        );
      }
      return r;
    } catch (error) {
      // Un Central caído no frena el loop: se reintenta en el próximo ciclo.
      logger.warn({ err: error, subsystem: 'sincronizador' }, 'no se pudo sincronizar; se reintenta en el próximo ciclo');
      return null;
    } finally {
      enCurso = false;
    }
  }

  const primera = ciclo(VENTANA_INICIAL_MINUTOS);
  const timer = setInterval(() => void ciclo(VENTANA_MINUTOS), intervaloMs);
  // No mantiene vivo el proceso por sí solo.
  timer.unref?.();

  return {
    primera,
    ciclo,
    detener: () => clearInterval(timer),
  };
}

module.exports = { iniciarSincronizadorEntrantes, INTERVALO_MS, VENTANA_MINUTOS, VENTANA_INICIAL_MINUTOS };
