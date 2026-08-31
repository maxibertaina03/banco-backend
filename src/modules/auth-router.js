const express = require('express');
const pool = require('../db/pool');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const clerkAuth = require('../middlewares/clerk-auth');

const router = express.Router();

router.get('/perfil', clerkAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.persona_id, u.activo, u.created_at,
            p.nombre, p.apellido, p.dni, p.email, p.telefono,
            p.fecha_nacimiento,
            COALESCE(
              json_agg(DISTINCT jsonb_build_object(
                'id', r.id,
                'nombre', r.nombre,
                'descripcion', r.descripcion
              )) FILTER (WHERE r.id IS NOT NULL),
              '[]'::json
            ) AS roles
     FROM usuarios u
     JOIN personas p ON p.id = u.persona_id
     LEFT JOIN personas_roles pr ON pr.persona_id = p.id
     LEFT JOIN roles r ON r.id = pr.rol_id
     WHERE u.clerk_id = $1
     GROUP BY u.id, p.id`,
    [req.clerkUserId]
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'No existe un perfil bancario para este usuario.');
  }

  const user = result.rows[0];
  user.perfil_completo = Boolean(user.nombre && user.apellido && user.dni && user.email && user.fecha_nacimiento);
  res.json({ message: 'Perfil obtenido correctamente.', user });
}));

module.exports = router;
