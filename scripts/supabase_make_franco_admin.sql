-- Hace admin al usuario FRANCO ARCE.
-- Ejecutar en el SQL Editor de Supabase.
--
-- Datos esperados:
--   persona_id o usuario_id relacionado: 08c01339-4685-44b6-a853-23ae4ad56cf0
--   nombre: FRANCO
--   apellido: ARCE
--
-- El script intenta resolver el UUID tanto contra `personas.id` como contra `usuarios.id`.
-- Si no encuentra una única persona compatible, aborta sin hacer cambios.

BEGIN;

DO $$
DECLARE
  v_target_id UUID := '08c01339-4685-44b6-a853-23ae4ad56cf0';
  v_admin_role_id UUID;
  v_persona_id UUID;
  v_match_count INTEGER;
BEGIN
  SELECT r.id
  INTO v_admin_role_id
  FROM roles r
  WHERE LOWER(r.nombre) = 'admin'
  ORDER BY r.id
  LIMIT 1;

  IF v_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'No existe el rol admin en la tabla roles.';
  END IF;

  SELECT COUNT(*)
  INTO v_match_count
  FROM personas p
  LEFT JOIN usuarios u ON u.persona_id = p.id
  WHERE LOWER(COALESCE(p.nombre, '')) = 'franco'
    AND LOWER(COALESCE(p.apellido, '')) = 'arce'
    AND (
      p.id = v_target_id
      OR u.id = v_target_id
    );

  IF v_match_count = 0 THEN
    RAISE EXCEPTION
      'No se encontro una persona unica con nombre FRANCO, apellido ARCE e id %.',
      v_target_id;
  END IF;

  IF v_match_count > 1 THEN
    RAISE EXCEPTION
      'Se encontraron % coincidencias para FRANCO ARCE con id %. Revisar datos antes de continuar.',
      v_match_count,
      v_target_id;
  END IF;

  SELECT p.id
  INTO v_persona_id
  FROM personas p
  LEFT JOIN usuarios u ON u.persona_id = p.id
  WHERE LOWER(COALESCE(p.nombre, '')) = 'franco'
    AND LOWER(COALESCE(p.apellido, '')) = 'arce'
    AND (
      p.id = v_target_id
      OR u.id = v_target_id
    )
  LIMIT 1;

  INSERT INTO personas_roles (persona_id, rol_id)
  VALUES (v_persona_id, v_admin_role_id)
  ON CONFLICT (persona_id, rol_id) DO NOTHING;
END $$;

COMMIT;

-- Verificacion
SELECT
  p.id AS persona_id,
  u.id AS usuario_id,
  p.nombre,
  p.apellido,
  p.email,
  u.clerk_id,
  ARRAY_AGG(r.nombre ORDER BY r.nombre) AS roles
FROM personas p
LEFT JOIN usuarios u ON u.persona_id = p.id
LEFT JOIN personas_roles pr ON pr.persona_id = p.id
LEFT JOIN roles r ON r.id = pr.rol_id
WHERE LOWER(COALESCE(p.nombre, '')) = 'franco'
  AND LOWER(COALESCE(p.apellido, '')) = 'arce'
  AND (
    p.id = '08c01339-4685-44b6-a853-23ae4ad56cf0'::uuid
    OR u.id = '08c01339-4685-44b6-a853-23ae4ad56cf0'::uuid
  )
GROUP BY p.id, u.id, p.nombre, p.apellido, p.email, u.clerk_id;
