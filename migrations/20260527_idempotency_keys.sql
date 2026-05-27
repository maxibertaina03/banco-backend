-- ============================================================
--  IDEMPOTENCY KEYS
--  Almacena requests recientes para que reintentos del cliente
--  (red mala, doble click, retries automáticos) no dupliquen
--  operaciones como transferencias.
--
--  Contrato con el cliente:
--    - El cliente genera un UUID por OPERACIÓN (no por request).
--    - Lo envía en header `Idempotency-Key`.
--    - Si reintenta la misma operación, manda el mismo UUID.
--    - El backend devuelve EXACTAMENTE la misma respuesta que la
--      primera vez (status + body), sin re-ejecutar la lógica.
--
--  Diseño:
--    - Scope por (usuario, endpoint, key): el mismo UUID puede
--      reutilizarse entre usuarios sin colisión.
--    - request_hash: detecta si el cliente reutilizó la key con
--      un body distinto → 422 (corrupción de cliente).
--    - status='in_flight': bloquea requests concurrentes con la
--      misma key → 409 (el cliente debe esperar).
--    - expires_at: limpieza periódica vía cron externo (job de
--      mantenimiento), no contamos con pg_cron.
-- ============================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key             TEXT NOT NULL,
  user_id         UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_flight'
                  CHECK (status IN ('in_flight', 'completed')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),

  -- Una key sólo puede usarse una vez por (usuario, endpoint).
  -- user_id puede ser NULL para endpoints públicos; en ese caso la unicidad
  -- queda por (endpoint, key) gracias al índice parcial de abajo.
  UNIQUE (user_id, endpoint, key)
);

-- Índice parcial para keys sin user_id (operaciones anónimas, si las hubiere).
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_no_user_unique
  ON idempotency_keys (endpoint, key)
  WHERE user_id IS NULL;

-- Para el job de limpieza periódica.
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON idempotency_keys (expires_at);

-- Comentario de la tabla para que aparezca en exploradores de schema.
COMMENT ON TABLE idempotency_keys IS
  'Cache de respuestas para implementar Idempotency-Key. TTL 24h.';
