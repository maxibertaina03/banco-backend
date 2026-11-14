const realDemoService = require('./demo-service');
const realLogger = require('../utils/logger');

/**
 * Borra las sesiones de prueba que vencieron.
 *
 * La consigna dice que al cerrar la sesión se borre lo que el visitante hizo.
 * El botón de salir cubre al que cierra bien; esto cubre al que simplemente se
 * va. Sin esto, cada visita dejaría para siempre una persona, dos cuentas y
 * trece movimientos en una base de verdad.
 *
 * Que una sesión siga existiendo vencida NO es un agujero: el middleware de
 * autenticación ya exige `expira_at > NOW()`, así que con el token viejo no se
 * entra. Esto es higiene de datos, no seguridad.
 *
 * Arranca en server.js y no en app.js, para que los tests que importan la app
 * no disparen timers.
 */

const INTERVALO_MS = 10 * 60 * 1000;

function iniciarLimpiadorDeDemos({
  intervaloMs = INTERVALO_MS,
  demoService = realDemoService,
  logger = realLogger,
} = {}) {
  let enCurso = false;

  async function ciclo() {
    // Si un ciclo tarda más que el intervalo, no se superpone con el siguiente:
    // dos barridos en paralelo se pelearían por las mismas filas.
    if (enCurso) return null;
    enCurso = true;
    try {
      const borradas = await demoService.barrerVencidas();
      if (borradas) {
        logger.info({ subsystem: 'demo', borradas }, 'sesiones de prueba vencidas borradas');
      }
      return borradas;
    } catch (error) {
      // Que falle no rompe nada: se reintenta en el próximo ciclo y mientras
      // tanto esas sesiones ya no dejan entrar a nadie.
      logger.warn({ err: error, subsystem: 'demo' }, 'no se pudieron borrar las sesiones vencidas; se reintenta');
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

module.exports = { iniciarLimpiadorDeDemos, INTERVALO_MS };
