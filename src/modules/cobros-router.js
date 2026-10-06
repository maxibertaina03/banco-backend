const express = require('express');
const { clerkMiddleware, getAuth } = require('@clerk/express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const env = require('../config/env');
const pool = require('../db/pool');
const requireActiveUser = require('../middlewares/require-active-user');
const createIdempotency = require('../middlewares/idempotency');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const requerirPerfilCompleto = require('../middlewares/require-complete-profile');
const { Dinero } = require('../utils/dinero');

const MAX_QR_AMOUNT = 1_000_000;
const RATE_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones con QR. Intentá de nuevo en unos minutos.' },
});
const clerkQrMiddleware = env.clerkPublishableKey
  ? clerkMiddleware({ publishableKey: env.clerkPublishableKey, secretKey: env.clerkSecretKey })
  : (_req, _res, next) => next(new HttpError(503, 'El backend necesita CLERK_PUBLISHABLE_KEY para habilitar los cobros QR.'));

function crearRouter() {
  const cobros = express.Router();
  const transferencias = express.Router();
  const idempotency = createIdempotency(pool);

  for (const router of [cobros, transferencias]) {
    router.use(RATE_LIMIT, clerkQrMiddleware, (req, res, next) => {
      const auth = getAuth(req);
      if (!auth.userId) return res.status(401).json({ error: 'Iniciá sesión para continuar.' });
      return next();
    }, requireActiveUser, requerirPerfilCompleto);
  }

  const crearSchema = z.object({
    monto: z.coerce.number().finite().positive().max(MAX_QR_AMOUNT)
      .refine((amount) => Number(amount.toFixed(2)) === amount, 'El monto admite como máximo dos decimales.'),
  });
  const idSchema = z.object({ id: z.string().uuid() });
  const pagarSchema = z.object({ cobro_id: z.string().uuid() });
  const claveIdempotenciaSchema = z.string().uuid();

  const validarAuditado = (schema, source, accion) => asyncHandler(async (req, _res, next) => {
    const resultado = schema.safeParse(req[source]);
    if (!resultado.success) {
      const posibleId = source === 'params' ? req.params.id : req.body?.cobro_id;
      const id = z.string().uuid().safeParse(posibleId).success ? posibleId : null;
      const error = new HttpError(400, 'Datos inválidos.', resultado.error.flatten());
      await auditarFallo(req, accion, id, error);
      return next(error);
    }
    req[source] = resultado.data;
    return next();
  });

  const exigirClaveIdempotencia = asyncHandler(async (req, _res, next) => {
    const resultado = claveIdempotenciaSchema.safeParse(req.get('Idempotency-Key'));
    if (!resultado.success) {
      const error = new HttpError(400, 'Enviá una Idempotency-Key válida (UUID) para confirmar el pago.');
      await auditarFallo(req, 'intento_pago_qr_fallido', req.body.cobro_id, error);
      return next(error);
    }
    return next();
  });

  const exigirReverificacion = asyncHandler(async (req, res, next) => {
    const auth = getAuth(req);
    if (auth.has({ reverification: 'strict' })) return next();

    const cobroId = req.body.cobro_id;
    await pool.query(
      `INSERT INTO auditoria
        (usuario_id, accion, entidad, entidad_id, payload_despues, ip_address, fuente)
       VALUES ($1, 'reverificacion_qr_requerida', 'cobros', $2, $3, $4, 'usuario')`,
      [
        req.usuarioActual.id,
        cobroId,
        { resultado: 'reverificacion_requerida', clerk_id: auth.userId },
        req.ip || null,
      ]
    );
    return res.status(403).json({
      clerk_error: {
        type: 'forbidden',
        reason: 'reverification-error',
        metadata: { reverification: 'strict' },
      },
    });
  });

  async function auditar(req, { accion, cobroId = null, antes = null, despues = null }) {
    const auth = getAuth(req);
    await pool.query(
      `INSERT INTO auditoria
        (usuario_id, accion, entidad, entidad_id, payload_antes, payload_despues, ip_address, fuente)
       VALUES ($1, $2, 'cobros', $3, $4, $5, $6, 'usuario')`,
      [
        req.usuarioActual?.id || null,
        accion,
        cobroId,
        antes,
        { ...(despues || {}), clerk_id: auth.userId || null },
        req.ip || null,
      ]
    );
  }

  async function auditarFallo(req, accion, cobroId, error) {
    try {
      await auditar(req, {
        accion,
        cobroId,
        despues: { resultado: 'fallido', error: error.message },
      });
    } catch (auditError) {
      req.log?.error({ err: auditError, cobroId }, 'No se pudo registrar el fallo de una operación QR');
    }
  }

  cobros.post(
    '/',
    validarAuditado(crearSchema, 'body', 'crear_cobro_qr_fallido'),
    asyncHandler(async (req, res) => {
      const { monto } = req.body;
      const client = await pool.connect();
      let cobro;
      try {
        await client.query('BEGIN');
        const cuenta = await client.query(
          `SELECT c.id, c.persona_id
             FROM cuentas c
            WHERE c.persona_id = $1 AND c.activa = TRUE AND c.principal = TRUE AND c.moneda = 'ARS'
            FOR UPDATE`,
          [req.usuarioActual.persona_id]
        );
        if (cuenta.rowCount !== 1) {
          throw new HttpError(
            400,
            cuenta.rowCount ? 'Hay más de una cuenta principal activa en pesos; contactá al banco.' : 'No tenés una cuenta principal activa en pesos para cobrar.'
          );
        }

        // No dejar generar un QR que después nadie va a poder pagar.
        //
        // El límite de transferencia es de la cuenta que PAGA, así que recién
        // saltaba al confirmar: el cobrador armaba un QR de $800.000, se lo
        // mostraba al otro, y el otro se comía el error. Acá se compara contra
        // el límite más alto que exista configurado: si ni la cuenta más
        // holgada del banco puede pagarlo, el QR no sirve para nadie.
        const techo = await client.query(
          'SELECT MAX(limite_transferencia) AS maximo FROM tipos_cuenta WHERE limite_transferencia IS NOT NULL'
        );
        const maximoPagable = Dinero.desdeOpcional(techo.rows[0]?.maximo);
        if (maximoPagable !== null && Dinero.desde(monto).mayorQue(maximoPagable)) {
          throw new HttpError(
            400,
            `El monto máximo que se puede cobrar por QR es ${maximoPagable.aNumero().toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })}, que es el límite de transferencia más alto del banco.`
          );
        }

        const creado = await client.query(
          `INSERT INTO cobros (cuenta_destino_id, monto, estado, expira_at)
           VALUES ($1, $2::numeric(14,2), 'pendiente', NOW() + INTERVAL '10 minutes')
           RETURNING id, monto, estado, expira_at, creado_at`,
          [cuenta.rows[0].id, monto.toFixed(2)]
        );
        cobro = creado.rows[0];
        await client.query(
          `INSERT INTO auditoria
            (usuario_id, accion, entidad, entidad_id, payload_despues, ip_address, fuente)
           VALUES ($1, 'crear_cobro_qr', 'cobros', $2, $3, $4, 'usuario')`,
          [
            req.usuarioActual.id,
            cobro.id,
            { monto: cobro.monto, expira_at: cobro.expira_at, clerk_id: getAuth(req).userId },
            req.ip || null,
          ]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        await auditarFallo(req, 'crear_cobro_qr_fallido', cobro?.id || null, error);
        throw error;
      } finally {
        client.release();
      }
      res.status(201).json(cobro);
    })
  );

  cobros.get(
    '/:id',
    validarAuditado(idSchema, 'params', 'consultar_cobro_qr_fallido'),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      try {
        const result = await pool.query(
          `SELECT co.id, co.monto, co.estado, co.expira_at, co.cuenta_destino_id,
                  p.nombre, p.apellido
             FROM cobros co
             JOIN cuentas c ON c.id = co.cuenta_destino_id
             JOIN personas p ON p.id = c.persona_id
            WHERE co.id = $1`,
          [id]
        );
        const cobro = result.rows[0];
        if (!cobro) throw new HttpError(404, 'No encontramos ese cobro.');

        if (cobro.estado === 'pendiente' && new Date(cobro.expira_at) <= new Date()) {
          const vencido = await pool.query(
            `UPDATE cobros SET estado = 'vencido'
              WHERE id = $1 AND estado = 'pendiente' RETURNING id`,
            [id]
          );
          if (vencido.rowCount) {
            await auditar(req, { accion: 'cobro_vencido', cobroId: id, despues: { estado: 'vencido' } });
          }
          throw new HttpError(410, 'Este QR venció. Pedile al titular que genere uno nuevo.');
        }
        if (cobro.estado !== 'pendiente') {
          throw new HttpError(409, cobro.estado === 'pagado' ? 'Este QR ya fue pagado.' : 'Este QR ya no está disponible.');
        }

        await auditar(req, {
          accion: 'consultar_cobro_qr',
          cobroId: id,
          despues: { estado: cobro.estado },
        });
        res.json({
          id: cobro.id,
          titular: [cobro.nombre, cobro.apellido].filter(Boolean).join(' ') || 'Titular de cuenta',
          monto: cobro.monto,
          estado: cobro.estado,
          expira_at: cobro.expira_at,
        });
      } catch (error) {
        if (error.status) {
          await auditarFallo(req, 'consultar_cobro_qr_fallido', id, error);
        }
        throw error;
      }
    })
  );

  transferencias.post(
    '/',
    validarAuditado(pagarSchema, 'body', 'intento_pago_qr_fallido'),
    exigirClaveIdempotencia,
    exigirReverificacion,
    idempotency,
    asyncHandler(async (req, res) => {
      const { cobro_id: cobroId } = req.body;
      const auth = getAuth(req);

      const client = await pool.connect();
      let transaccion;
      let committed = false;
      try {
        await client.query('BEGIN');
        const cobroResult = await client.query(
          'SELECT * FROM cobros WHERE id = $1 FOR UPDATE',
          [cobroId]
        );
        const cobro = cobroResult.rows[0];
        if (!cobro) throw new HttpError(404, 'No encontramos ese cobro.');
        if (cobro.estado !== 'pendiente') {
          throw new HttpError(409, cobro.estado === 'pagado' ? 'Este QR ya fue pagado.' : 'Este QR ya no está disponible.');
        }
        if (new Date(cobro.expira_at) <= new Date()) {
          await client.query("UPDATE cobros SET estado = 'vencido' WHERE id = $1", [cobroId]);
          await client.query('COMMIT');
          committed = true;
          throw new HttpError(410, 'Este QR venció. Pedile al titular que genere uno nuevo.');
        }

        const origenResult = await client.query(
          `SELECT id FROM cuentas
            WHERE persona_id = $1 AND activa = TRUE AND principal = TRUE AND moneda = 'ARS'`,
          [req.usuarioActual.persona_id]
        );
        if (origenResult.rowCount !== 1) {
          throw new HttpError(
            400,
            origenResult.rowCount ? 'Hay más de una cuenta principal activa en pesos; contactá al banco.' : 'No tenés una cuenta principal activa en pesos para transferir.'
          );
        }
        const cuentaOrigenId = origenResult.rows[0]?.id;
        if (cuentaOrigenId === cobro.cuenta_destino_id) {
          throw new HttpError(400, 'No podés pagar un QR de tu propia cuenta.');
        }

        const cuentaIds = [cuentaOrigenId, cobro.cuenta_destino_id].sort();
        const cuentasResult = await client.query(
          `SELECT c.*, p.nombre, p.apellido
             FROM cuentas c JOIN personas p ON p.id = c.persona_id
            WHERE c.id = ANY($1::uuid[])
            ORDER BY c.id
            FOR UPDATE OF c`,
          [cuentaIds]
        );
        if (cuentasResult.rowCount !== 2) throw new HttpError(404, 'No encontramos una de las cuentas del cobro.');
        const cuentas = new Map(cuentasResult.rows.map((cuenta) => [cuenta.id, cuenta]));
        const origen = cuentas.get(cuentaOrigenId);
        const destino = cuentas.get(cobro.cuenta_destino_id);

        if (origen.persona_id === destino.persona_id) {
          throw new HttpError(400, 'No podés pagar un QR de tu propia cuenta.');
        }
        if (!origen.activa || !destino.activa || origen.moneda !== 'ARS' || destino.moneda !== 'ARS') {
          throw new HttpError(400, 'Las cuentas del cobro no están disponibles para operar en pesos.');
        }

        // El límite de la cuenta también rige acá.
        //
        // Una transferencia común pasa por `validarLimiteDeTransferencia`, que
        // compara el monto contra el `limite_transferencia` del tipo de cuenta
        // (hoy, Caja de Ahorro: $500.000). Este camino no lo hacía: su único
        // tope era el MAX_QR_AMOUNT de arriba, que es un millón. Pagando por QR
        // se movía el doble de lo que el banco permite por el formulario de
        // siempre.
        const tipoDeCuenta = await client.query(
          'SELECT limite_transferencia FROM tipos_cuenta WHERE id = $1',
          [origen.tipo_cuenta_id]
        );
        const limite = Dinero.desdeOpcional(tipoDeCuenta.rows[0]?.limite_transferencia);
        if (limite !== null && Dinero.desde(cobro.monto).mayorQue(limite)) {
          throw new HttpError(400, 'El monto supera el límite de transferencia permitido para la cuenta.');
        }
        const tipo = await client.query("SELECT id FROM tipos_transaccion WHERE lower(nombre) = 'transferencia' LIMIT 1");
        if (!tipo.rows[0]) throw new HttpError(500, 'No está configurado el tipo de transacción transferencia.');

        const debito = await client.query(
          'UPDATE cuentas SET saldo = saldo - $1 WHERE id = $2 AND saldo >= $1 RETURNING id',
          [cobro.monto, origen.id]
        );
        if (!debito.rowCount) throw new HttpError(422, 'No tenés saldo suficiente para esta transferencia.');
        await client.query('UPDATE cuentas SET saldo = saldo + $1 WHERE id = $2', [cobro.monto, destino.id]);
        const inserted = await client.query(
          `INSERT INTO transacciones
             (tipo_transaccion_id, cuenta_origen_id, cuenta_destino_id, monto, descripcion,
              estado, canal, cbu_origen, cbu_destino)
           VALUES ($1, $2, $3, $4, 'Pago por QR', 'completada', 'local', $5, $6)
           RETURNING id, monto, estado, created_at`,
          [tipo.rows[0].id, origen.id, destino.id, cobro.monto, origen.cbu, destino.cbu]
        );
        transaccion = inserted.rows[0];
        await client.query(
          `UPDATE cobros SET estado = 'pagado', pagado_at = NOW(), transferencia_id = $2 WHERE id = $1`,
          [cobroId, transaccion.id]
        );
        await client.query(
          `INSERT INTO auditoria
            (usuario_id, accion, entidad, entidad_id, payload_despues, ip_address, fuente)
           VALUES ($1, 'pagar_cobro_qr', 'cobros', $2, $3, $4, 'usuario')`,
          [
            req.usuarioActual.id,
            cobroId,
            { estado: 'pagado', transferencia_id: transaccion.id, clerk_id: auth.userId },
            req.ip || null,
          ]
        );
        await client.query('COMMIT');
        committed = true;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK');
        await auditarFallo(req, 'intento_pago_qr_fallido', cobroId, error);
        throw error;
      } finally {
        client.release();
      }
      res.status(201).json({
        id: transaccion.id,
        cobro_id: cobroId,
        monto: transaccion.monto,
        estado: transaccion.estado,
        fecha: transaccion.created_at,
      });
    })
  );

  return { cobros, transferencias };
}

module.exports = crearRouter();
