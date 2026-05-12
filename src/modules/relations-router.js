const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const { uuidLike } = require('../utils/schemas');
const { hasAnyRole, isInternalUser } = require('../utils/access-control');

const router = express.Router();

const paramsSchema = z.object({
  id: uuidLike,
});

function assertCanAccessPersona(req, personaId) {
  if (isInternalUser(req.currentUser) || req.currentUser.persona_id === personaId) {
    return;
  }

  throw new HttpError(403, 'No tienes permisos para acceder a los datos de otra persona.');
}

async function assertCanAccessCuenta(req, cuentaId) {
  if (isInternalUser(req.currentUser)) {
    return;
  }

  const result = await pool.query('SELECT persona_id FROM cuentas WHERE id = $1', [cuentaId]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
  }

  if (result.rows[0].persona_id !== req.currentUser.persona_id) {
    throw new HttpError(403, 'No tienes permisos para acceder a esa cuenta.');
  }
}

async function assertCanAccessUsuarioAuditoria(req, userId) {
  if (hasAnyRole(req.currentUser, ['admin', 'auditor'])) {
    return;
  }

  const result = await pool.query('SELECT persona_id FROM usuarios WHERE id = $1', [userId]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el usuario con id ${userId}.`);
  }

  if (result.rows[0].persona_id !== req.currentUser.persona_id) {
    throw new HttpError(403, 'No tienes permisos para consultar la auditoría de otro usuario.');
  }
}

router.get(
  '/catalogos/transferencias',
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      'SELECT id, nombre, descripcion FROM tipos_transaccion ORDER BY nombre ASC'
    );

    res.json(result.rows);
  })
);

router.get(
  '/personas/:id/full',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertCanAccessPersona(req, id);

    const personaResult = await pool.query('SELECT * FROM personas WHERE id = $1', [id]);
    if (personaResult.rowCount === 0) {
      throw new HttpError(404, `No existe la persona con id ${id}.`);
    }

    const [usuario, cuentas, destinatarios, roles] = await Promise.all([
      pool.query('SELECT * FROM usuarios WHERE persona_id = $1 ORDER BY created_at DESC LIMIT 1', [id]),
      pool.query(
        `SELECT c.*, tc.nombre AS tipo_cuenta_nombre, tc.descripcion AS tipo_cuenta_descripcion
         FROM cuentas c
         JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
         WHERE c.persona_id = $1
         ORDER BY c.created_at DESC`,
        [id]
      ),
      pool.query('SELECT * FROM destinatarios WHERE persona_id = $1 ORDER BY created_at DESC', [id]),
      pool.query(
        `SELECT r.*, pr.id AS persona_rol_id, pr.asignado_at
         FROM personas_roles pr
         JOIN roles r ON r.id = pr.rol_id
         WHERE pr.persona_id = $1
         ORDER BY pr.asignado_at DESC`,
        [id]
      ),
    ]);

    res.json({
      persona: personaResult.rows[0],
      usuario: usuario.rows[0] || null,
      cuentas: cuentas.rows,
      destinatarios: destinatarios.rows,
      roles: roles.rows,
    });
  })
);

router.get(
  '/personas/:id/cuentas',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const result = await pool.query(
      `SELECT c.*, tc.nombre AS tipo_cuenta_nombre
       FROM cuentas c
       JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
       WHERE c.persona_id = $1
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  '/personas/:id/roles',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const result = await pool.query(
      `SELECT r.*, pr.id AS persona_rol_id, pr.asignado_at
       FROM personas_roles pr
       JOIN roles r ON r.id = pr.rol_id
       WHERE pr.persona_id = $1
       ORDER BY pr.asignado_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  '/personas/:id/destinatarios',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const result = await pool.query(
      'SELECT * FROM destinatarios WHERE persona_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  '/cuentas/:id/transacciones',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    await assertCanAccessCuenta(req, req.params.id);

    const result = await pool.query(
      `SELECT t.*,
              tt.nombre AS tipo_transaccion_nombre,
              origen.numero_cuenta AS cuenta_origen_numero,
              destino.numero_cuenta AS cuenta_destino_numero
       FROM transacciones t
       JOIN tipos_transaccion tt ON tt.id = t.tipo_transaccion_id
       JOIN cuentas origen ON origen.id = t.cuenta_origen_id
       LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
       WHERE t.cuenta_origen_id = $1 OR t.cuenta_destino_id = $1
       ORDER BY t.created_at DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  '/usuarios/:id/auditoria',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    await assertCanAccessUsuarioAuditoria(req, req.params.id);

    const result = await pool.query(
      'SELECT * FROM auditoria WHERE usuario_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json(result.rows);
  })
);

module.exports = router;
