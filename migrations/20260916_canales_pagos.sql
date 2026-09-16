-- ============================================================================
--  CANALES DE SERVICIOS Y RECARGAS
-- ============================================================================
--
--  El banco ahora paga facturas de servicios y recarga celulares contra
--  banco-proveedores. Los dos débitos pasan por `movimientos.debitar()`, así
--  que necesitan su canal: sin esto, el CHECK rechaza la transacción y el pago
--  falla entero (que es lo correcto, pero por el motivo equivocado).
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
      'prestamo_acreditado',
      'cuota_prestamo',
      'plazo_fijo_constitucion',
      'plazo_fijo_acreditacion',
      'consumo_tarjeta',
      -- Nuevos.
      'pago_servicio',
      'recarga_celular'
    )
  );

-- `nombre` no tiene constraint único, así que se chequea con NOT EXISTS.
INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'pago', 'Pago de servicios y recargas a través de proveedores externos'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'pago');

COMMIT;

-- Verificación:
--   SELECT unnest(enum_range(NULL)) IS NULL;  -- no aplica: el canal es CHECK, no enum
--   SELECT nombre FROM tipos_transaccion ORDER BY nombre;
