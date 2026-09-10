-- ============================================================
--  SECURITY HARDENING MIGRATION
--  Habilita RLS en tablas sensibles, agrega constraints de
--  integridad y los índices que faltaban.
-- ============================================================

-- ── 1. RLS en tablas sensibles ────────────────────────────────────────────────
-- El backend accede vía service role (DATABASE_URL con service key de Supabase),
-- que bypassea RLS. Estas políticas bloquean acceso directo desde:
--   - Supabase Studio con rol 'anon' o 'authenticated'
--   - Cualquier cliente que use la anon/service key de forma incorrecta

ALTER TABLE personas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuentas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transacciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE destinatarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria     ENABLE ROW LEVEL SECURITY;

-- Denegar todo acceso directo (solo el backend con service role puede operar)
CREATE POLICY "deny_direct_access" ON personas      AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON usuarios      AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON cuentas       AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON transacciones AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON destinatarios AS RESTRICTIVE FOR ALL USING (false);
CREATE POLICY "deny_direct_access" ON auditoria     AS RESTRICTIVE FOR ALL USING (false);

-- ── 2. Constraints de integridad ─────────────────────────────────────────────

-- Saldo nunca negativo (previene descubiertos accidentales por bug)
ALTER TABLE cuentas ADD CONSTRAINT chk_saldo_no_negativo
  CHECK (saldo >= 0);

-- Monto de transacción siempre positivo
ALTER TABLE transacciones ADD CONSTRAINT chk_monto_positivo
  CHECK (monto > 0);

-- Estado de transacción solo valores válidos
ALTER TABLE transacciones ADD CONSTRAINT chk_estado_valido
  CHECK (estado IN ('pendiente', 'completada', 'rechazada'));

-- Canal solo valores válidos
ALTER TABLE transacciones ADD CONSTRAINT chk_canal_valido
  CHECK (canal IN ('local', 'interbancaria_saliente', 'interbancaria_entrante'));

-- ── 3. Índices faltantes ─────────────────────────────────────────────────────

-- Búsqueda de deduplicación en sync (crítico — se ejecuta en cada sync)
CREATE INDEX IF NOT EXISTS idx_transacciones_central_id
  ON transacciones(central_transaction_id)
  WHERE central_transaction_id IS NOT NULL;

-- Búsqueda combinada usada en sync: central_transaction_id + canal
CREATE INDEX IF NOT EXISTS idx_transacciones_central_canal
  ON transacciones(central_transaction_id, canal)
  WHERE central_transaction_id IS NOT NULL;

-- Listado cronológico de transacciones (query más frecuente del usuario)
CREATE INDEX IF NOT EXISTS idx_transacciones_created_at
  ON transacciones(created_at DESC);

-- Lookup de cuenta por CBU (usado en cada transferencia y sync)
CREATE INDEX IF NOT EXISTS idx_cuentas_cbu
  ON cuentas(cbu)
  WHERE cbu IS NOT NULL;

-- Cuentas activas por persona (path crítico en requireActiveUser)
CREATE INDEX IF NOT EXISTS idx_cuentas_persona_activa
  ON cuentas(persona_id)
  WHERE activa = TRUE;

-- Lookup de usuarios por clerk_id (se ejecuta en CADA request autenticado)
CREATE INDEX IF NOT EXISTS idx_usuarios_clerk_id
  ON usuarios(clerk_id);

-- ── 4. Fix auditoría: usuario_id nullable + campo fuente ─────────────────────
-- usuario_id era NOT NULL, lo que impedía auditar acciones de sistema
-- (webhooks, jobs, sync automático) que no tienen usuario asociado.

ALTER TABLE auditoria ALTER COLUMN usuario_id DROP NOT NULL;

ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS fuente TEXT NOT NULL DEFAULT 'usuario'
  CONSTRAINT chk_fuente_valida CHECK (fuente IN ('usuario', 'sistema', 'webhook', 'job'));
