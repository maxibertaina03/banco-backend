-- ============================================================================
--  TARJETAS Y AUTORIZACIONES
-- ============================================================================
--
--  Fase 4 del plan. Dos tablas:
--
--    tarjetas       — débito (atada a una cuenta) o crédito (con límite propio).
--    autorizaciones — cada consumo, aprobado o rechazado. Se guardan los dos:
--                     un rechazo es información valiosa para el cliente y para
--                     la auditoría, no un evento a descartar.
--
--  Sobre el número de tarjeta: se guarda completo porque el sistema tiene que
--  poder validarlo, pero **nunca sale por el API**. El DTO expone sólo los
--  últimos cuatro dígitos. En un banco real esto iría cifrado o tokenizado; acá
--  alcanza con no exponerlo, que es lo que el proyecto puede sostener.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS tarjetas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id    UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
  numero        TEXT NOT NULL UNIQUE,
  -- Obligatoria en débito, NULL en crédito: la de débito debita de una cuenta,
  -- la de crédito tiene su propio límite y no está atada a ninguna.
  cuenta_id     UUID REFERENCES cuentas(id) ON DELETE SET NULL,
  limite        NUMERIC(18,2),
  estado        TEXT NOT NULL DEFAULT 'activa',
  vencimiento   DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_tarjeta_tipo   CHECK (tipo IN ('debito', 'credito')),
  CONSTRAINT chk_tarjeta_estado CHECK (estado IN ('activa', 'bloqueada', 'vencida')),
  -- La regla de negocio, en la base y no sólo en el código: una de débito exige
  -- cuenta y no lleva límite; una de crédito exige límite y no lleva cuenta.
  CONSTRAINT chk_tarjeta_coherente CHECK (
    (tipo = 'debito'  AND cuenta_id IS NOT NULL AND limite IS NULL) OR
    (tipo = 'credito' AND limite IS NOT NULL AND limite > 0)
  )
);

CREATE INDEX IF NOT EXISTS tarjetas_persona_idx ON tarjetas (persona_id);
CREATE INDEX IF NOT EXISTS tarjetas_cuenta_idx  ON tarjetas (cuenta_id);

CREATE TABLE IF NOT EXISTS autorizaciones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tarjeta_id     UUID NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
  comercio       TEXT NOT NULL,
  monto          NUMERIC(18,2) NOT NULL,
  cuotas         INTEGER NOT NULL DEFAULT 1,
  estado         TEXT NOT NULL,
  motivo_rechazo TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_autorizacion_estado CHECK (estado IN ('aprobada', 'rechazada')),
  CONSTRAINT chk_autorizacion_monto  CHECK (monto > 0),
  CONSTRAINT chk_autorizacion_cuotas CHECK (cuotas >= 1),
  -- Una rechazada tiene que decir por qué. Sin esto es fácil terminar con
  -- rechazos mudos que nadie puede explicarle al cliente.
  CONSTRAINT chk_autorizacion_motivo CHECK (
    (estado = 'aprobada' AND motivo_rechazo IS NULL) OR
    (estado = 'rechazada' AND motivo_rechazo IS NOT NULL)
  )
);

-- El resumen de una tarjeta de crédito filtra por tarjeta y período, así que el
-- índice lleva las dos columnas en ese orden.
CREATE INDEX IF NOT EXISTS autorizaciones_tarjeta_fecha_idx
  ON autorizaciones (tarjeta_id, created_at DESC);

COMMIT;

-- ── Verificación ────────────────────────────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('tarjetas', 'autorizaciones');
--   -- deben aparecer las dos
