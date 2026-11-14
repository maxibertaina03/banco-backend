-- Modo demo: sesiones de prueba que se entran por QR y se borran al cerrar.
--
-- Los datos del demo viven en las MISMAS tablas que los de un cliente real, a
-- propósito: así el usuario de prueba ejercita el sistema de verdad y no una
-- maqueta. El aislamiento sale del scoping por persona_id que ya tiene todo el
-- backend; lo único que hace falta agregar es por dónde entra y cómo se limpia.
--
-- Revisar y aplicar en Supabase antes de habilitar los endpoints.

-- Marca para que las personas de prueba no se mezclen en los listados del
-- personal del banco, los reportes ni la sincronización con el Banco Central.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS es_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice parcial: las consultas normales filtran es_demo = false y las demo son
-- un puñado, así que indexar sólo esas alcanza y no engorda el índice.
CREATE INDEX IF NOT EXISTS idx_personas_demo ON personas(id) WHERE es_demo;

CREATE TABLE demo_sesiones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sólo el sha256 del token. La base nunca guarda algo con lo que se pueda
  -- entrar: ni un volcado del dump sirve para abrir una sesión.
  token_hash TEXT NOT NULL UNIQUE,
  persona_id UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  creada_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_at TIMESTAMPTZ NOT NULL,
  cerrada_at TIMESTAMPTZ,
  ip_origen TEXT,
  CONSTRAINT demo_sesiones_fechas_validas CHECK (expira_at > creada_at)
);

-- Por acá entra el middleware de autenticación en cada request, así que la
-- busca por hash tiene que ser barata.
CREATE INDEX idx_demo_sesiones_vivas ON demo_sesiones(expira_at) WHERE cerrada_at IS NULL;

ALTER TABLE demo_sesiones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny_direct_access" ON demo_sesiones
  AS RESTRICTIVE FOR ALL USING (false) WITH CHECK (false);
