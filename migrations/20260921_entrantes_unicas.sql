-- ============================================================================
--  UNA TRANSFERENCIA ENTRANTE SE ACREDITA UNA SOLA VEZ
-- ============================================================================
--
--  La sincronización de entrantes deduplicaba con "¿ya existe? si no, la
--  inserto", y eso no alcanza cuando dos sincronizaciones corren a la vez: las
--  dos ven que no existe y las dos acreditan. Se reprodujo contra esta base:
--  tres sincronizaciones en paralelo acreditaron la misma transferencia tres
--  veces (US$ 0,18 en vez de 0,06).
--
--  Con el índice único, la segunda inserción falla, su transacción se deshace
--  y la acreditación no queda. Es la base la que garantiza la regla, no el
--  código: el código solo no puede con la concurrencia.
--
--  Sólo para las entrantes: una transferencia saliente también guarda el id
--  del Central, y no tiene por qué chocar con una entrante.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_transacciones_entrante_central
  ON transacciones (central_transaction_id)
  WHERE canal = 'interbancaria_entrante';
