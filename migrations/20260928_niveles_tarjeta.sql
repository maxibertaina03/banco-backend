-- ============================================================================
--  NIVELES DE TARJETA DE CRÉDITO (Standard, Gold, Platinum, Black)
-- ============================================================================
--
--  Hasta acá el cliente mandaba el límite que quería, que es justo lo que un
--  banco no hace. Ahora cada tarjeta de crédito tiene un nivel, y el límite
--  sale del nivel, que el banco otorga según la situación en la Central de
--  Deudores y el patrimonio del cliente.
--
--  Las tarjetas que ya existen se clasifican por el límite que tenían.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

BEGIN;

ALTER TABLE tarjetas ADD COLUMN IF NOT EXISTS nivel TEXT;

-- Las que ya existían se clasifican por su límite, redondeando al nivel más
-- cercano (una de 1.000.000 queda Gold, no Standard).
UPDATE tarjetas
   SET nivel = CASE
     WHEN limite >= 8000000 THEN 'black'
     WHEN limite >= 3000000 THEN 'platinum'
     WHEN limite >= 800000  THEN 'gold'
     ELSE 'standard'
   END
 WHERE tipo = 'credito' AND nivel IS NULL;

-- Y el límite pasa a ser el del nivel: si no, quedan tarjetas Standard con
-- límite de Gold y el nivel no significa nada.
UPDATE tarjetas
   SET limite = CASE nivel
     WHEN 'black' THEN 15000000
     WHEN 'platinum' THEN 5000000
     WHEN 'gold' THEN 1500000
     ELSE 300000
   END
 WHERE tipo = 'credito';

-- La regla en la base y no sólo en el código: crédito lleva nivel, débito no.
ALTER TABLE tarjetas DROP CONSTRAINT IF EXISTS chk_tarjeta_nivel;
ALTER TABLE tarjetas
  ADD CONSTRAINT chk_tarjeta_nivel CHECK (
    (tipo = 'credito' AND nivel IN ('standard', 'gold', 'platinum', 'black')) OR
    (tipo = 'debito'  AND nivel IS NULL)
  );

COMMIT;
