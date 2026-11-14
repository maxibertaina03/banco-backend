const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const realDemoService = require('./demo-service');
const realPool = require('../db/pool');
const movimientos = require('./movimientos');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');

/**
 * Las sesiones de prueba.
 *
 * `POST /sesiones` es el único endpoint PÚBLICO de toda la API: es el que
 * atiende al que escaneó el QR y todavía no es nadie. De ahí los dos límites:
 * uno por IP y un techo global de sesiones vivas, porque cada sesión escribe
 * una persona, dos cuentas y trece movimientos en la base de verdad.
 */

/** Más que esto a la vez no tiene sentido y empieza a ser peso muerto. */
const MAXIMO_SESIONES_VIVAS = 50;

const limitePorIp = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Ya abriste varias sesiones de prueba. Esperá un rato o reutilizá la que tenés.' },
});

const entranteSchema = z.object({
  monto: z.coerce.number().finite().positive().max(500000),
  remitente: z.string().trim().min(1).max(60).optional(),
});

function crearRouters({ demoService = realDemoService, pool = realPool } = {}) {
  // Público: por acá entra el QR.
  const publico = express.Router();

  publico.post(
    '/sesiones',
    limitePorIp,
    asyncHandler(async (req, res) => {
      const vivas = await pool.query(
        'SELECT count(*)::int AS n FROM demo_sesiones WHERE cerrada_at IS NULL AND expira_at > NOW()'
      );
      if (vivas.rows[0].n >= MAXIMO_SESIONES_VIVAS) {
        throw new HttpError(503, 'Hay demasiadas sesiones de prueba abiertas. Probá en unos minutos.');
      }

      const sesion = await demoService.crearSesion({ ipOrigen: req.ip || null });
      res.status(201).json({
        token: sesion.token,
        expira_at: sesion.expira_at,
        aviso: 'Sesión de prueba. Los datos son ficticios y se borran al salir.',
      });
    })
  );

  // Autenticado: cuelga de la cadena de /api, así que sólo lo alcanza quien ya
  // tiene una sesión demo válida.
  const privado = express.Router();

  /** Cerrar la sesión y borrar todo lo que el visitante hizo. */
  privado.delete(
    '/sesiones/actual',
    asyncHandler(async (req, res) => {
      if (!req.esDemo) {
        throw new HttpError(403, 'Esto sólo aplica a las sesiones de prueba.');
      }
      await demoService.borrarSesion(req.usuarioActual.persona_id);
      res.json({ message: 'Sesión de prueba cerrada. No quedó ningún dato.' });
    })
  );

  /**
   * Simula que otro banco le transfiere plata al visitante.
   *
   * Existe porque la consigna pide poder coordinar con otro equipo y mostrar
   * una transferencia entre bancos, pero sin pasar por el Banco Central —que es
   * compartido con todo el curso—. Acá la entrada se finge de este lado.
   */
  privado.post(
    '/entrante',
    validate(entranteSchema),
    asyncHandler(async (req, res) => {
      if (!req.esDemo) {
        throw new HttpError(403, 'Esto sólo aplica a las sesiones de prueba.');
      }
      const { monto, remitente = 'Banco de prueba' } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cuenta = (await client.query(
          `SELECT id, cbu FROM cuentas
            WHERE persona_id = $1 AND activa AND principal AND moneda = 'ARS'
            FOR UPDATE`,
          [req.usuarioActual.persona_id]
        )).rows[0];
        if (!cuenta) throw new HttpError(400, 'La sesión de prueba no tiene una caja en pesos.');

        const fila = await movimientos.acreditar(client, {
          cuentaId: cuenta.id,
          cbu: cuenta.cbu,
          monto: monto.toFixed(2),
          tipo: 'transferencia',
          canal: 'interbancaria_entrante',
          descripcion: `Transferencia recibida de ${remitente}`,
        });
        await client.query('COMMIT');

        res.status(201).json({ id: fila.id, monto: fila.monto, fecha: fila.created_at });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })
  );

  return { publico, privado };
}

module.exports = crearRouters();
module.exports.crearRouters = crearRouters;
