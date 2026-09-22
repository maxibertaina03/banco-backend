-- ============================================================================
--  BONIFICACIONES (la "órbita secreta" del login)
-- ============================================================================
--
--  Quien toca el isotipo que orbita en el login o el registro se gana una
--  bonificación de bienvenida: US$ 5 en su caja en dólares.
--
--  Es plata que el banco regala, así que el límite de "una vez por persona"
--  lo pone la base con una restricción única, no el código ni el navegador:
--  un flag en el navegador se saltea llamando a la API directo, y un chequeo
--  en el código deja pasar a dos pedidos simultáneos.
--
--  EJECUTAR MANUALMENTE en Supabase.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS bonificaciones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id     UUID NOT NULL REFERENCES personas(id),
  tipo           TEXT NOT NULL,
  monto          NUMERIC(18, 2) NOT NULL CHECK (monto > 0),
  moneda         TEXT NOT NULL CHECK (moneda IN ('ARS', 'USD')),
  transaccion_id UUID REFERENCES transacciones(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_bonificacion_por_persona UNIQUE (persona_id, tipo)
);

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
      'pago_servicio',
      'recarga_celular',
      -- Nuevo.
      'bonificacion'
    )
  );

-- `nombre` no tiene constraint único, así que se chequea con NOT EXISTS.
INSERT INTO tipos_transaccion (nombre, descripcion)
SELECT 'bonificacion', 'Bonificaciones que el banco otorga a sus clientes'
WHERE NOT EXISTS (SELECT 1 FROM tipos_transaccion WHERE nombre = 'bonificacion');

COMMIT;
