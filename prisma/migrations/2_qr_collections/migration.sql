-- Cobros por QR. Revisar y aplicar en Supabase antes de habilitar los endpoints.
CREATE TABLE cobros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cuenta_destino_id UUID NOT NULL REFERENCES cuentas(id) ON DELETE RESTRICT,
  monto NUMERIC(14, 2) NOT NULL CHECK (monto > 0),
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'pagado', 'vencido', 'cancelado')),
  expira_at TIMESTAMPTZ NOT NULL,
  creado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pagado_at TIMESTAMPTZ,
  transferencia_id UUID UNIQUE REFERENCES transacciones(id) ON DELETE RESTRICT,
  CONSTRAINT cobros_fechas_validas CHECK (expira_at > creado_at),
  CONSTRAINT cobros_pago_consistente CHECK (
    (estado = 'pagado' AND pagado_at IS NOT NULL AND transferencia_id IS NOT NULL)
    OR (estado <> 'pagado' AND pagado_at IS NULL AND transferencia_id IS NULL)
  )
);

CREATE INDEX idx_cobros_cuenta_estado ON cobros(cuenta_destino_id, estado);
CREATE INDEX idx_cobros_expira_at ON cobros(expira_at);

ALTER TABLE cobros ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_direct_access" ON cobros
  AS RESTRICTIVE FOR ALL USING (false) WITH CHECK (false);
