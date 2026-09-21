-- Cargar saldo de prueba desde el SQL Editor de Supabase.
--
-- Hace lo mismo que `npm run depositar`: registra el movimiento y suma el
-- saldo, en una sola operación. NO usar un UPDATE directo al saldo: la plata
-- aparece sin ningún movimiento que la explique y el extracto no cuadra.
--
-- Cambiá sólo los tres valores de la línea `SELECT ... AS dni` de abajo.
-- Si no devuelve ninguna fila, esa persona no tiene caja activa en esa moneda:
-- para abrirla hace falta el Banco Central, así que usá
-- `npm run depositar -- <dni> USD <monto> --abrir`.
WITH datos AS (
  SELECT '44673782'::text AS dni, 'ARS'::text AS moneda, 100000.00::numeric AS monto
),
cuenta AS (
  SELECT c.id, c.cbu
  FROM cuentas c
  JOIN personas p ON p.id = c.persona_id
  JOIN datos d ON d.dni = p.dni AND c.moneda = d.moneda
  WHERE c.activa = true
  ORDER BY c.created_at
  LIMIT 1
),
movimiento AS (
  INSERT INTO transacciones
    (tipo_transaccion_id, cuenta_origen_id, cuenta_destino_id, monto, descripcion, estado, canal, cbu_origen, cbu_destino)
  SELECT (SELECT id FROM tipos_transaccion WHERE nombre = 'deposito' LIMIT 1),
         NULL, cuenta.id, datos.monto, 'Depósito de saldo de prueba',
         'completada', 'deposito_efectivo', NULL, cuenta.cbu
  FROM cuenta, datos
  RETURNING cuenta_destino_id, monto
)
UPDATE cuentas c
SET saldo = c.saldo + m.monto
FROM movimiento m
WHERE c.id = m.cuenta_destino_id
RETURNING c.cbu, c.moneda, c.saldo AS saldo_nuevo;
