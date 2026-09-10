-- ============================================================
--  SECURITY HARDENING (capa NO modelable por Prisma)
--
--  Prisma no expresa: RLS, políticas, CHECK constraints ni índices
--  parciales. Esta migración los agrega DESPUÉS de 0_init para que un
--  deploy fresco reproduzca el schema COMPLETO de producción.
--
--  Deriva de las migraciones legacy ya aplicadas y testeadas en prod:
--    - migrations/20260421_central_bank_integration.sql (RLS de config)
--    - migrations/20260521_security_hardening.sql
--    - migrations/20260527_idempotency_keys.sql (índice parcial)
--
--  Se omite todo lo que 0_init ya crea (tablas, columnas, índices no
--  parciales, uniques). Solo van acá los objetos que Prisma no maneja.
-- ============================================================

-- ── RLS en tablas sensibles ───────────────────────────────────────────────────
-- El backend accede vía service role (bypassa RLS). Estas políticas bloquean
-- acceso directo desde roles anon/authenticated de Supabase.
ALTER TABLE personas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuentas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transacciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE destinatarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_direct_access" ON personas      AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON usuarios      AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON cuentas       AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON transacciones AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON destinatarios AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON auditoria     AS RESTRICTIVE FOR ALL USING (false);

-- RLS de la configuración del Banco Central (datos sensibles: API keys).
ALTER TABLE banco_central_configuracion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE banco_central_configuracion FROM anon;
REVOKE ALL ON TABLE banco_central_configuracion FROM authenticated;

-- ── CHECK constraints de integridad ───────────────────────────────────────────
ALTER TABLE cuentas ADD CONSTRAINT chk_saldo_no_negativo
  CHECK (saldo >= 0);

ALTER TABLE transacciones ADD CONSTRAINT chk_monto_positivo
  CHECK (monto > 0);

ALTER TABLE transacciones ADD CONSTRAINT chk_estado_valido
  CHECK (estado IN ('pendiente', 'completada', 'rechazada'));

ALTER TABLE transacciones ADD CONSTRAINT chk_canal_valido
  CHECK (canal IN ('local', 'interbancaria_saliente', 'interbancaria_entrante'));

-- La columna `fuente` ya la crea 0_init; acá solo agregamos su CHECK.
ALTER TABLE auditoria ADD CONSTRAINT chk_fuente_valida
  CHECK (fuente IN ('usuario', 'sistema', 'webhook', 'job'));

-- El status de idempotency_keys también lo crea 0_init sin CHECK.
ALTER TABLE idempotency_keys ADD CONSTRAINT chk_idempotency_status
  CHECK (status IN ('in_flight', 'completed'));

-- ── Índices parciales (no representables en Prisma) ────────────────────────────
-- Deduplicación en sync (solo filas con central_transaction_id).
CREATE INDEX IF NOT EXISTS idx_transacciones_central_id
  ON transacciones(central_transaction_id)
  WHERE central_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_central_canal
  ON transacciones(central_transaction_id, canal)
  WHERE central_transaction_id IS NOT NULL;

-- Lookup de cuenta por CBU (solo cuentas con CBU).
CREATE INDEX IF NOT EXISTS idx_cuentas_cbu_partial
  ON cuentas(cbu)
  WHERE cbu IS NOT NULL;

-- Cuentas activas por persona (path crítico en requireActiveUser).
CREATE INDEX IF NOT EXISTS idx_cuentas_persona_activa
  ON cuentas(persona_id)
  WHERE activa = TRUE;

-- Unicidad de idempotency-key para operaciones sin user_id (anónimas).
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_no_user_unique
  ON idempotency_keys (endpoint, key)
  WHERE user_id IS NULL;
