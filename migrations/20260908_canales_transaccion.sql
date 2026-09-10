-- ============================================================================
--  CANALES DE TRANSACCIÓN: depósito, extracción y cambio de divisa
-- ============================================================================
--
--  El check `chk_canal_valido` sólo admitía tres canales: local,
--  interbancaria_saliente e interbancaria_entrante.
--
--  BUG PREEXISTENTE que esto arregla: `crearDeposito` inserta con
--  `canal = 'deposito_efectivo'` desde que se escribió, así que **el depósito en
--  efectivo siempre falló** contra la base real. No se detectó antes porque sus
--  tests mockean el pool, y en la tabla no hay una sola fila con ese canal.
--
--  Se suman además los dos canales de la fase 3:
--    - extraccion_efectivo → espejo del depósito.
--    - cambio_divisa       → compra y venta de dólares entre cuentas del mismo
--                            titular. Es la única operación que cruza monedas.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

BEGIN;

ALTER TABLE transacciones DROP CONSTRAINT IF EXISTS chk_canal_valido;

ALTER TABLE transacciones
  ADD CONSTRAINT chk_canal_valido CHECK (
    canal IS NULL OR canal IN (
      'local',
      'interbancaria_saliente',
      'interbancaria_entrante',
      'deposito_efectivo',
      'extraccion_efectivo',
      'cambio_divisa'
    )
  );

COMMIT;

-- Verificación: los seis canales deben pasar.
--   SELECT unnest(ARRAY['local','interbancaria_saliente','interbancaria_entrante',
--                       'deposito_efectivo','extraccion_efectivo','cambio_divisa']);
