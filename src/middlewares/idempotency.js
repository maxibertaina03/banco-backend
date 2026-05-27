const crypto = require('crypto');
const HttpError = require('../utils/http-error');
const baseLogger = require('../utils/logger');

// Status que vale la pena cachear: respuestas determinísticas que no van a
// cambiar si el cliente reintenta. 5xx y 429 se EXCLUYEN porque suelen ser
// transitorios — al cliente le interesa que el retry los re-ejecute.
const CACHEABLE_STATUS = new Set([200, 201, 204, 400, 404, 409, 422]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashBody(body) {
  // JSON.stringify es estable para objetos planos. Si el cliente envía
  // claves en orden distinto la hash cambia — eso es deseado: significa
  // que efectivamente es un payload distinto.
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

function endpointId(req) {
  // `req.baseUrl + req.route?.path` resolvería el patrón ("/api/transacciones/:id"),
  // pero `route` no siempre está disponible antes del handler. `originalUrl`
  // sería demasiado específico (incluiría query params). Usamos baseUrl+path
  // como compromiso pragmático.
  return `${req.method} ${req.baseUrl || ''}${req.path}`;
}

/**
 * Crea un middleware de idempotencia.
 *
 * Uso:
 *   const pool = require('../db/pool');
 *   const idempotency = createIdempotency(pool);
 *   router.post('/transferir', idempotency, handler);
 *
 * Si el cliente NO envía header `Idempotency-Key`, el middleware no hace nada
 * (la idempotencia es opt-in del cliente). Si lo envía, la primera respuesta
 * se cachea por 24h y los retries con la misma key devuelven la respuesta
 * cacheada sin re-ejecutar el handler.
 *
 * Estados:
 *   - in_flight: hay otro request concurrente con la misma key → 409.
 *   - completed: ya hay respuesta cacheada → devolverla.
 *   - completed + payload distinto: cliente reusó la key con otro body → 422.
 */
function createIdempotency(pool, options = {}) {
  // El log se usa solo para errores secundarios (BD caída en lookup, persist
  // async fallido). El happy path no genera ruido — el access log de pino-http
  // ya cubre la línea por request. Acepta override por options.log para tests.
  const fallbackLogger = baseLogger.child({ middleware: 'idempotency' });
  const log = options.log || ((msg, ctx) => fallbackLogger.warn(ctx || {}, msg));

  return async function idempotencyMiddleware(req, res, next) {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey) return next();

    const key = String(rawKey).trim();
    if (!UUID_REGEX.test(key)) {
      return next(new HttpError(400, 'Idempotency-Key debe ser un UUID v4.'));
    }

    const userId = req.currentUser?.id || null;
    const endpoint = endpointId(req);
    const requestHash = hashBody(req.body);

    let client;
    try {
      client = await pool.connect();

      // 1. Intentar reservar la key como "in_flight". Si ya existe, recuperarla
      //    en el mismo round-trip con ON CONFLICT DO NOTHING + segundo SELECT.
      const insertResult = await client.query(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, endpoint, key) DO NOTHING
         RETURNING id`,
        [key, userId, endpoint, requestHash]
      );

      if (insertResult.rowCount === 0) {
        // Key ya existe. Decidir según el estado.
        const existing = await client.query(
          `SELECT status, request_hash, response_status, response_body
           FROM idempotency_keys
           WHERE user_id IS NOT DISTINCT FROM $1
             AND endpoint = $2
             AND key = $3
           LIMIT 1`,
          [userId, endpoint, key]
        );

        const row = existing.rows[0];
        client.release();
        client = null;

        if (!row) {
          // Race ultra-rara: la fila se eliminó entre el INSERT y el SELECT.
          // Tratar como nuevo intento sin idempotencia.
          return next();
        }

        if (row.request_hash !== requestHash) {
          return next(
            new HttpError(
              422,
              'Idempotency-Key reutilizada con un body distinto. Generá una nueva key para esta operación.'
            )
          );
        }

        if (row.status === 'in_flight') {
          // El cliente envió el mismo request dos veces y el primero aún no
          // termina. Mejor que reintentar ciegamente: 409 para que espere.
          return next(
            new HttpError(409, 'Hay un request en curso con esa Idempotency-Key. Esperá unos segundos.')
          );
        }

        // status === 'completed': replicar la respuesta cacheada.
        res.set('Idempotent-Replay', 'true');
        return res.status(row.response_status || 200).json(row.response_body);
      }

      // 2. Reservamos la key. Liberar el client antes del handler para no
      //    quedarnos con la conexión.
      client.release();
      client = null;

      // 3. Interceptar res.json para capturar el body que el handler envía.
      //    Después de que se mande, guardar el resultado en la tabla.
      const originalJson = res.json.bind(res);
      let captured = false;

      res.json = (body) => {
        if (captured) return originalJson(body);
        captured = true;

        const finalStatus = res.statusCode || 200;
        if (CACHEABLE_STATUS.has(finalStatus)) {
          // Persistir async — no bloqueamos la response del cliente. Si falla
          // el persist, la key queda como 'in_flight' y eventualmente expira;
          // el cliente puede reintentar (sin idempotencia efectiva pero sin
          // duplicación porque la lógica de negocio se ejecutó OK).
          pool
            .query(
              `UPDATE idempotency_keys
               SET status = 'completed',
                   response_status = $1,
                   response_body = $2,
                   completed_at = NOW()
               WHERE user_id IS NOT DISTINCT FROM $3
                 AND endpoint = $4
                 AND key = $5`,
              [finalStatus, body ?? null, userId, endpoint, key]
            )
            .catch((err) => log('no se pudo completar idempotency key', { err: err.message }));
        } else {
          // Status no-cacheable (5xx, 429): liberar la key para permitir retry.
          pool
            .query(
              `DELETE FROM idempotency_keys
               WHERE user_id IS NOT DISTINCT FROM $1
                 AND endpoint = $2
                 AND key = $3
                 AND status = 'in_flight'`,
              [userId, endpoint, key]
            )
            .catch((err) => log('no se pudo liberar idempotency key transitoria', { err: err.message }));
        }

        return originalJson(body);
      };

      // 4. Limpieza si el handler nunca llama res.json (timeout, error sin
      //    response): borrar la reserva para que el cliente pueda reintentar.
      res.on('close', () => {
        if (captured) return;
        pool
          .query(
            `DELETE FROM idempotency_keys
             WHERE user_id IS NOT DISTINCT FROM $1
               AND endpoint = $2
               AND key = $3
               AND status = 'in_flight'`,
            [userId, endpoint, key]
          )
          .catch((err) => log('no se pudo liberar idempotency key abortada', { err: err.message }));
      });

      return next();
    } catch (err) {
      if (client) client.release();
      // Si la BD falla, no bloqueamos: dejamos pasar SIN idempotencia. Mejor
      // permitir la operación que tirar 500 cuando la causa es secundaria.
      log('error en middleware idempotency, fallthrough', { err: err.message });
      return next();
    }
  };
}

module.exports = createIdempotency;
module.exports.hashBody = hashBody; // exportado para tests
