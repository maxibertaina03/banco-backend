-- 
--  SOLO CAJA DE AHORRO
--  Decisión de negocio: Banco Orbital solo opera con "Caja de Ahorro"
--  como tipo de cuenta. Los demás tipos (Cuenta Corriente, Cuenta
--  Sueldo, Caja de Ahorro en Dólares) provenían del seed y no son
--  parte del producto final.
--
--  Esta migración borra esos tipos y las cuentas asociadas. Es
--  IDEMPOTENTE: corerla múltiples veces no rompe nada.
--
--  Antes de correr en producción:
--    - Asegurate de que las cuentas a borrar tengan saldo 0 o que el
--      saldo no importe (datos de prueba).
--    - Si tenés cuentas reales de otros tipos, no corras esta migración.
-- ============================================================

-- 1. Borrar transacciones donde origen/destino sea cuenta de tipo no permitido.
--    Hacemos esto ANTES de borrar las cuentas (FK violation).
DELETE FROM transacciones
WHERE cuenta_origen_id IN (
  SELECT c.id FROM cuentas c
  JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
  WHERE tc.nombre <> 'Caja de Ahorro'
)
OR cuenta_destino_id IN (
  SELECT c.id FROM cuentas c
  JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
  WHERE tc.nombre <> 'Caja de Ahorro'
);

-- 2. Borrar cuentas de tipo no permitido.
DELETE FROM cuentas
WHERE tipo_cuenta_id IN (
  SELECT id FROM tipos_cuenta WHERE nombre <> 'Caja de Ahorro'
);

-- 3. Borrar los tipos no permitidos del catálogo.
DELETE FROM tipos_cuenta WHERE nombre <> 'Caja de Ahorro';

-- 4. Garantizar que la Caja de Ahorro existe con un límite razonable.
INSERT INTO tipos_cuenta (id, nombre, descripcion, limite_transferencia)
VALUES (
  '44444444-4444-4444-4444-000000000001',
  'Caja de Ahorro',
  'Cuenta de ahorro en pesos argentinos',
  500000.00
)
ON CONFLICT (id) DO UPDATE
SET nombre = EXCLUDED.nombre,
    descripcion = EXCLUDED.descripcion,
    limite_transferencia = EXCLUDED.limite_transferencia;

-- 5. Comentario para el explorador de schema.
COMMENT ON TABLE tipos_cuenta IS
  'Catálogo de tipos de cuenta. Banco Orbital solo opera con Caja de Ahorro.';
