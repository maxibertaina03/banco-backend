-- ============================================================================
--  PRÉSTAMOS, CUOTAS Y PLAZOS FIJOS
-- ============================================================================
--
--  Fase 5 del plan. Tres tablas.
--
--  Sobre por qué el cronograma va en su propia tabla y no como JSON en el
--  préstamo: cada cuota tiene estado propio (pendiente, pagada, en mora) y hay
--  que consultarlas de a muchas para el barrido de mora. Con un JSON habría que
--  leer y reescribir el préstamo entero para marcar una cuota como pagada, y no
--  se podría indexar por vencimiento.
--
--  Sobre las columnas calculadas del préstamo (cuota_mensual, total_a_pagar,
--  cft): se guardan aunque sean derivables. Un préstamo queda **congelado** con
--  la tasa del día en que se otorgó, así que recalcularlos después con la tasa
--  vigente daría otro número. Guardarlos es lo que hace que el contrato con el
--  cliente sea inmutable.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS prestamos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id         UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  -- Dónde se acreditó el capital y de dónde se debitan las cuotas. Define la
  -- moneda del préstamo.
  cuenta_id          UUID NOT NULL REFERENCES cuentas(id),
  moneda             VARCHAR(3) NOT NULL DEFAULT 'ARS',
  capital            NUMERIC(18,2) NOT NULL,
  cuotas             INTEGER NOT NULL,
  -- TNA en PORCENTAJE (72 = 72 %). Ojo: ArgentinaDatos la publica como fracción
  -- decimal; el adapter de mercado la normaliza antes de llegar acá.
  tna                NUMERIC(8,4) NOT NULL,
  tem                NUMERIC(8,6) NOT NULL,
  cuota_mensual      NUMERIC(18,2) NOT NULL,
  total_a_pagar      NUMERIC(18,2) NOT NULL,
  total_intereses    NUMERIC(18,2) NOT NULL,
  cft                NUMERIC(8,2) NOT NULL,
  saldo_deuda        NUMERIC(18,2) NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'vigente',
  fecha_otorgamiento DATE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_prestamo_estado  CHECK (estado IN ('vigente', 'cancelado', 'en_mora')),
  CONSTRAINT chk_prestamo_moneda  CHECK (moneda IN ('ARS', 'USD')),
  CONSTRAINT chk_prestamo_capital CHECK (capital > 0),
  CONSTRAINT chk_prestamo_cuotas  CHECK (cuotas >= 1 AND cuotas <= 72),
  CONSTRAINT chk_prestamo_saldo   CHECK (saldo_deuda >= 0)
);

CREATE INDEX IF NOT EXISTS prestamos_persona_idx ON prestamos (persona_id);
-- El barrido de mora filtra por estado, así que va indexado.
CREATE INDEX IF NOT EXISTS prestamos_estado_idx  ON prestamos (estado);

CREATE TABLE IF NOT EXISTS cuotas_prestamo (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prestamo_id  UUID NOT NULL REFERENCES prestamos(id) ON DELETE CASCADE,
  numero       INTEGER NOT NULL,
  vencimiento  DATE NOT NULL,
  cuota        NUMERIC(18,2) NOT NULL,
  capital      NUMERIC(18,2) NOT NULL,
  interes      NUMERIC(18,2) NOT NULL,
  saldo        NUMERIC(18,2) NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pendiente',
  fecha_pago   DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_cuota_estado CHECK (estado IN ('pendiente', 'pagada', 'en_mora')),
  -- Una cuota pagada tiene que tener fecha de pago, y una que no lo está, no.
  CONSTRAINT chk_cuota_fecha_pago CHECK (
    (estado = 'pagada' AND fecha_pago IS NOT NULL) OR
    (estado <> 'pagada' AND fecha_pago IS NULL)
  ),
  UNIQUE (prestamo_id, numero)
);

-- El barrido de mora busca cuotas vencidas e impagas: ese es el índice que usa.
CREATE INDEX IF NOT EXISTS cuotas_vencimiento_estado_idx
  ON cuotas_prestamo (vencimiento, estado) WHERE estado <> 'pagada';

CREATE TABLE IF NOT EXISTS plazos_fijos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id         UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  cuenta_id          UUID NOT NULL REFERENCES cuentas(id),
  moneda             VARCHAR(3) NOT NULL DEFAULT 'ARS',
  capital            NUMERIC(18,2) NOT NULL,
  dias               INTEGER NOT NULL,
  tna                NUMERIC(8,4) NOT NULL,
  interes            NUMERIC(18,2) NOT NULL,
  total              NUMERIC(18,2) NOT NULL,
  tea                NUMERIC(8,2) NOT NULL,
  fecha_constitucion DATE NOT NULL,
  fecha_vencimiento  DATE NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'vigente',
  fecha_acreditacion DATE,
  total_acreditado   NUMERIC(18,2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_pf_estado  CHECK (estado IN ('vigente', 'vencido', 'acreditado', 'cancelado_anticipado')),
  CONSTRAINT chk_pf_moneda  CHECK (moneda IN ('ARS', 'USD')),
  CONSTRAINT chk_pf_capital CHECK (capital > 0),
  CONSTRAINT chk_pf_dias    CHECK (dias >= 30 AND dias <= 365)
);

CREATE INDEX IF NOT EXISTS plazos_fijos_persona_idx ON plazos_fijos (persona_id);
-- Filtrar por estado='vencido' es cómo se sabe qué hay que acreditar hoy.
CREATE INDEX IF NOT EXISTS plazos_fijos_estado_idx  ON plazos_fijos (estado, fecha_vencimiento);

COMMIT;

-- ── Verificación ────────────────────────────────────────────────────────────
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('prestamos', 'cuotas_prestamo', 'plazos_fijos');
--   -- deben aparecer las tres
