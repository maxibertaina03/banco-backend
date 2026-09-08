-- ============================================================================
--  CUENTAS MULTI-MONEDA
-- ============================================================================
--
--  Contexto: el Banco Central publicó `POST /accounts`, que permite abrir una
--  caja de ahorro en dólares además de la de pesos. Cada cuenta tiene su propio
--  CBU y su propio alias.
--
--  La tabla `cuentas` ya soportaba N cuentas por persona (`persona_id` no es
--  único, y `cbu`/`alias` son únicos por cuenta). Lo único que faltaba era saber
--  de qué moneda es cada una, y qué cuenta es la principal.
--
--  Modelo del Banco Central, que replicamos:
--    - La caja en ARS nace junto con la persona (`POST /persons`) y es la
--      principal. `POST /accounts` con moneda ARS no crea nada: devuelve la que ya
--      existe.
--    - La caja en USD se abre aparte y tiene CBU propio.
--    - Una sola cuenta por persona y por moneda.
--
--  EJECUTAR MANUALMENTE en Supabase. `db-setup.js` no corre migraciones.
-- ============================================================================

BEGIN;

-- ── 1. Moneda ───────────────────────────────────────────────────────────────
-- Se agrega con DEFAULT 'ARS' para que las filas existentes queden marcadas
-- correctamente sin necesitar un UPDATE aparte: todo lo que hay hoy es en pesos.
ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS moneda VARCHAR(3) NOT NULL DEFAULT 'ARS';

-- Sólo las dos monedas acordadas. Si mañana se suma EUR, se cambia acá.
ALTER TABLE cuentas
  DROP CONSTRAINT IF EXISTS cuentas_moneda_check;
ALTER TABLE cuentas
  ADD CONSTRAINT cuentas_moneda_check CHECK (moneda IN ('ARS', 'USD'));

-- ── 2. Cuenta principal ─────────────────────────────────────────────────────
-- Es la que nació con la persona en el Banco Central. Importa porque los
-- endpoints heredados (`GET /persons/{cbu}`) la usan como identidad de la
-- persona, y porque es a la que se acreditan los depósitos por defecto.
ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS principal BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: la cuenta en pesos más antigua de cada persona es la principal.
-- Se usa `created_at` y se desempata por `id` para que sea determinista aunque
-- dos filas compartan timestamp.
WITH primeras AS (
  SELECT DISTINCT ON (persona_id) id
  FROM cuentas
  WHERE moneda = 'ARS'
  ORDER BY persona_id, created_at ASC, id ASC
)
UPDATE cuentas c
SET principal = TRUE
FROM primeras p
WHERE c.id = p.id;

-- ── 3. Una cuenta por persona y moneda ──────────────────────────────────────
-- Es la regla del Banco Central: `POST /accounts` con una moneda que la persona
-- ya tiene devuelve 200 con la existente en vez de crear otra. Si permitiéramos
-- dos cajas en la misma moneda, la segunda no se podría registrar allá.
--
-- Índice parcial sobre las activas: una cuenta cerrada no debe bloquear la
-- apertura de una nueva en la misma moneda.
CREATE UNIQUE INDEX IF NOT EXISTS cuentas_persona_moneda_activa_unique
  ON cuentas (persona_id, moneda)
  WHERE activa;

-- Una sola cuenta principal por persona, por la misma razón.
CREATE UNIQUE INDEX IF NOT EXISTS cuentas_persona_principal_unique
  ON cuentas (persona_id)
  WHERE principal;

-- ── 4. Índice para el listado del portal ────────────────────────────────────
CREATE INDEX IF NOT EXISTS cuentas_persona_moneda_idx
  ON cuentas (persona_id, moneda);

COMMIT;

-- ── Verificación ────────────────────────────────────────────────────────────
-- Correr después de aplicar. Toda persona con cuentas debe tener exactamente
-- una principal, y ninguna debe tener dos cuentas activas en la misma moneda.
--
--   SELECT persona_id, COUNT(*) FILTER (WHERE principal) AS principales,
--          COUNT(*) AS total
--   FROM cuentas
--   GROUP BY persona_id
--   HAVING COUNT(*) FILTER (WHERE principal) <> 1;
--   -- debe devolver 0 filas
