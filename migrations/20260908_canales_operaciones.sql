-- ============================================================================
--  CANALES PARA PRÉSTAMOS, PLAZOS FIJOS Y TARJETAS
-- ============================================================================
--
--  Bug que esto habilita arreglar: préstamos, plazos fijos y consumos de
--  tarjeta movían el saldo con un UPDATE directo, sin registrar la transacción.
--  El cliente veía su saldo saltar un millón al sacar un préstamo, y en el
--  extracto no había nada que lo explicara.
--
--  Se suman los canales que faltaban, y el tipo de transacción para cada uno.
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
      'cambio_divisa',
      -- Nuevos: cada uno explica un movimiento que antes era invisible.
      'prestamo_acreditado',
      'cuota_prestamo',
      'plazo_fijo_constitucion',
      'plazo_fijo_acreditacion',
      'consumo_tarjeta'
    )
  );

-- `nombre` no tiene constraint único, así que se chequea con NOT EXISTS.
INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'prestamo', 'Acreditación de capital y cobro de cuotas de un préstamo'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'prestamo');

INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'plazo_fijo', 'Constitución y acreditación de un plazo fijo'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'plazo_fijo');

INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'consumo_tarjeta', 'Consumo autorizado con tarjeta de débito'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'consumo_tarjeta');

COMMIT;
