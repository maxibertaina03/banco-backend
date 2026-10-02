-- El rol gerente y el circuito de aprobación de préstamos.
--
-- Hasta ahora un préstamo se otorgaba al instante: si la Central de Deudores
-- daba el OK, la plata se acreditaba en el momento, y si no, el cliente recibía
-- un 403 y ahí terminaba todo. No había forma de que una persona revisara el
-- caso.
--
-- Ahora el que no pasa el filtro automático queda `pendiente_revision` y un
-- gerente decide. El que sí pasa sigue igual que siempre.

BEGIN;

-- ── El rol ──────────────────────────────────────────────────────────────────
-- Sin ON CONFLICT porque `roles.nombre` no tiene índice único: se comprueba a
-- mano para que la migración se pueda correr dos veces sin duplicar el rol.
INSERT INTO roles (nombre, descripcion)
SELECT 'gerente', 'Aprueba o rechaza los prestamos que no pasan el filtro automatico'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE nombre = 'gerente');

-- ── El expediente de la revisión ────────────────────────────────────────────
ALTER TABLE prestamos
  -- La situación que tenía el cliente en la Central cuando pidió. Se guarda
  -- congelada: dentro de seis meses puede ser otra, y para entender por qué se
  -- aprobó hay que saber cuál era ese día.
  ADD COLUMN IF NOT EXISTS situacion_al_solicitar SMALLINT,
  ADD COLUMN IF NOT EXISTS revisado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revisado_en TIMESTAMPTZ,
  -- Por qué el gerente aprobó o rechazó. Obligatorio al aprobar una excepción:
  -- un préstamo otorgado contra el criterio del banco sin explicación no se
  -- puede defender después.
  ADD COLUMN IF NOT EXISTS motivo_revision TEXT;

-- ── Los estados ─────────────────────────────────────────────────────────────
-- `vigente` y `cancelado` ya existían; se suman los dos del circuito nuevo.
ALTER TABLE prestamos DROP CONSTRAINT IF EXISTS chk_prestamo_estado;
ALTER TABLE prestamos ADD CONSTRAINT chk_prestamo_estado
  CHECK (estado IN ('pendiente_revision', 'rechazado', 'vigente', 'en_mora', 'cancelado'));

-- Un préstamo pendiente o rechazado todavía no entregó un peso: su saldo de
-- deuda tiene que ser cero. Si no, aparecería como deuda en los totales.
ALTER TABLE prestamos DROP CONSTRAINT IF EXISTS chk_prestamo_sin_acreditar;
ALTER TABLE prestamos ADD CONSTRAINT chk_prestamo_sin_acreditar
  CHECK (estado NOT IN ('pendiente_revision', 'rechazado') OR saldo_deuda = 0);

-- La bandeja del gerente se consulta por estado y se ordena por antigüedad.
CREATE INDEX IF NOT EXISTS idx_prestamos_pendientes
  ON prestamos (created_at)
  WHERE estado = 'pendiente_revision';

COMMIT;
