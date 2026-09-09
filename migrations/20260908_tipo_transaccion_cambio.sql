-- ============================================================================
--  TIPO DE TRANSACCIÓN "cambio"
-- ============================================================================
--
--  El cambio de divisa no encajaba en ninguno de los tipos existentes
--  (deposito, retiro, transferencia, pago, ajuste). Se podría haber reusado
--  `transferencia`, ya que mueve plata entre dos cuentas, pero sería mentir en
--  el dato: una transferencia va de un titular a otro y no cruza monedas,
--  mientras que un cambio es del mismo titular consigo mismo y sólo existe
--  porque cruza monedas.
--
--  El canal de la transacción ya es `cambio_divisa`; esto alinea el tipo.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

-- `nombre` no tiene constraint único en esta tabla, así que no se puede usar
-- ON CONFLICT: se chequea con NOT EXISTS para que la migración sea reejecutable.
INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'cambio', 'Compra o venta de moneda extranjera entre cuentas del mismo titular'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'cambio');

-- Verificación: debe devolver una fila.
--   SELECT id, nombre FROM tipos_transaccion WHERE nombre = 'cambio';
