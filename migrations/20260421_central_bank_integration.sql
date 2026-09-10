CREATE TABLE IF NOT EXISTS banco_central_configuracion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL DEFAULT 'test',
  api_url TEXT NOT NULL DEFAULT 'https://centralbank.brocoly.cc/api',
  register_token TEXT,
  api_key TEXT,
  bank_name TEXT,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (environment)
);

ALTER TABLE banco_central_configuracion ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE banco_central_configuracion FROM anon;
REVOKE ALL ON TABLE banco_central_configuracion FROM authenticated;

CREATE TABLE IF NOT EXISTS banco_central_registro (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_id TEXT NOT NULL,
  bank_code INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'test',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (bank_id, environment),
  UNIQUE (bank_code, environment)
);

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS alias TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS banco_central_registrada BOOLEAN DEFAULT FALSE;

ALTER TABLE transacciones
  ALTER COLUMN cuenta_origen_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS central_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS cbu_origen TEXT,
  ADD COLUMN IF NOT EXISTS cbu_destino TEXT;

CREATE INDEX IF NOT EXISTS idx_cuentas_alias
  ON cuentas(alias);

CREATE INDEX IF NOT EXISTS idx_transacciones_canal
  ON transacciones(canal);

CREATE INDEX IF NOT EXISTS idx_transacciones_cbu_origen
  ON transacciones(cbu_origen);

CREATE INDEX IF NOT EXISTS idx_transacciones_cbu_destino
  ON transacciones(cbu_destino);
