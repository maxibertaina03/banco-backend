const express = require('express');
const { z } = require('zod');
const pool = require('../db/pool');
const validate = require('../middlewares/validate');
const asyncHandler = require('../utils/async-handler');
const HttpError = require('../utils/http-error');
const { uuidLike } = require('../utils/schemas');
const { tieneAlgunRol, esUsuarioInterno } = require('../utils/access-control');
const centralBankService = require('./central-bank-service');
const cuentasService = require('./cuentas-service');
const {
  aPersonaPublica,
  aUsuarioPublico,
  aCuentaPublica,
  aTransaccionPublica,
  aDestinatarioPublico,
  aRolPublico,
} = require('../dtos');

const router = express.Router();
const BASIC_SAVINGS_NAME = 'Caja de Ahorro';

const paramsSchema = z.object({
  id: uuidLike,
});

function generarNumeroDeCuenta(personaId) {
  const personaDigits = String(personaId || '').replace(/\D+/g, '').slice(-6).padStart(6, '0');
  const timestampDigits = Date.now().toString().slice(-6);
  return `${personaDigits}${timestampDigits}`.slice(0, 12);
}

function generateCbu(personaId) {
  const personaDigits = String(personaId || '').replace(/\D+/g, '').slice(-10).padStart(10, '0');
  const timestampDigits = Date.now().toString().slice(-12).padStart(12, '0');
  return `${personaDigits}${timestampDigits}`.slice(0, 22);
}

function assertCanAccessPersona(req, personaId) {
  if (esUsuarioInterno(req.usuarioActual) || req.usuarioActual.persona_id === personaId) {
    return;
  }

  throw new HttpError(403, 'No tienes permisos para acceder a los datos de otra persona.');
}

async function assertCanAccessCuenta(req, cuentaId) {
  if (esUsuarioInterno(req.usuarioActual)) {
    return;
  }

  const result = await pool.query('SELECT persona_id FROM cuentas WHERE id = $1', [cuentaId]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe la cuenta con id ${cuentaId}.`);
  }

  if (result.rows[0].persona_id !== req.usuarioActual.persona_id) {
    throw new HttpError(403, 'No tienes permisos para acceder a esa cuenta.');
  }
}

async function assertCanAccessUsuarioAuditoria(req, userId) {
  if (tieneAlgunRol(req.usuarioActual, ['admin', 'auditor'])) {
    return;
  }

  const result = await pool.query('SELECT persona_id FROM usuarios WHERE id = $1', [userId]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el usuario con id ${userId}.`);
  }

  if (result.rows[0].persona_id !== req.usuarioActual.persona_id) {
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
      persona: aPersonaPublica(personaResult.rows[0]),
      usuario: aUsuarioPublico(usuario.rows[0]),
      cuentas: cuentas.rows.map(aCuentaPublica),
      destinatarios: destinatarios.rows.map(aDestinatarioPublico),
      roles: roles.rows.map(aRolPublico),
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

    res.json(result.rows.map(aCuentaPublica));
  })
);

const aperturaSchema = z.object({
  moneda: z.enum(['ARS', 'USD']),
  alias: z.string().trim().min(1).max(40).nullable().optional(),
  environment: z.enum(['test', 'prod']).optional(),
});

// Apertura de una caja de ahorro en la moneda pedida. En la práctica se usa para
// la de dólares: la de pesos ya existe desde que la persona se registra.
//
// Devuelve 201 si la creó y 200 si ya existía, replicando el criterio del Banco
// Central para que reintentar sea seguro.
router.post(
  '/personas/:id/cuentas/apertura',
  validate(paramsSchema, 'params'),
  validate(aperturaSchema),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const { cuenta, creada } = await cuentasService.abrirCuenta({
      personaId: req.params.id,
      moneda: req.body.moneda,
      alias: req.body.alias ?? null,
      usuarioActual: req.currentUser,
      ipAddress: req.ip || null,
      environment: req.body.environment,
    });

    res.status(creada ? 201 : 200).json(aCuentaPublica(cuenta));
  })
);

router.post(
  '/personas/:id/cuentas/apertura-basica',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const personaResult = await client.query('SELECT id FROM personas WHERE id = $1 LIMIT 1', [req.params.id]);

      if (personaResult.rowCount === 0) {
        throw new HttpError(404, `No existe la persona con id ${req.params.id}.`);
      }

      const cuentasExistentes = await client.query(
        'SELECT id FROM cuentas WHERE persona_id = $1 LIMIT 1',
        [req.params.id]
      );

      if (cuentasExistentes.rowCount > 0) {
        throw new HttpError(
          409,
          'La persona ya tiene cuentas creadas. La apertura automática solo aplica a usuarios sin cuentas.'
        );
      }

      const resultadoTipoDeCuenta = await client.query(
        'SELECT id FROM tipos_cuenta WHERE nombre = $1 ORDER BY id ASC LIMIT 1',
        [BASIC_SAVINGS_NAME]
      );

      if (resultadoTipoDeCuenta.rowCount === 0) {
        throw new HttpError(500, 'No se encontró el tipo de cuenta Caja de Ahorro.');
      }

      let created = null;
      let attempts = 0;

      while (!created && attempts < 5) {
        attempts += 1;
        const numeroCuenta = generarNumeroDeCuenta(req.params.id);
        const cbu = generateCbu(req.params.id);

        try {
          const insertResult = await client.query(
            `INSERT INTO cuentas (
              persona_id,
              tipo_cuenta_id,
              numero_cuenta,
              cbu,
              saldo,
              activa,
              banco_central_registrada
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *`,
            [req.params.id, resultadoTipoDeCuenta.rows[0].id, numeroCuenta, cbu, 0, true, false]
          );

          created = insertResult.rows[0];
        } catch (error) {
          if (error?.code === '23505') {
            continue;
          }

          throw error;
        }
      }

      if (!created) {
        throw new HttpError(500, 'No se pudo generar una cuenta única para la persona.');
      }

      const enriched = await client.query(
        `SELECT c.*, tc.nombre AS tipo_cuenta_nombre, tc.descripcion AS tipo_cuenta_descripcion
         FROM cuentas c
         JOIN tipos_cuenta tc ON tc.id = c.tipo_cuenta_id
         WHERE c.id = $1
         LIMIT 1`,
        [created.id]
      );

      await client.query('COMMIT');

      // Best-effort: register with Brocoly immediately if persona has complete perfil data.
      // On success, the CBU stored locally gets replaced with the real Brocoly-assigned CBU.
      let centralBank = null;
      const personaFull = await pool.query(
        'SELECT nombre, apellido, dni, email, telefono FROM personas WHERE id = $1 LIMIT 1',
        [req.params.id]
      );
      const p = personaFull.rows[0];

      if (p?.nombre && p?.apellido && p?.dni) {
        try {
          const centralResult = await centralBankService.registrarPersonaLocalDesdeCentral(
            {
              nombre: p.nombre,
              apellido: p.apellido,
              dni: p.dni,
              email: p.email,
              telefono: p.telefono,
              environment: 'test',
            },
            { usuarioId: req.usuarioActual?.id || null, ipAddress: req.ip || null }
          );
          centralBank = {
            status: centralResult.status,
            message: centralResult.message,
            cbu: centralResult.cuenta?.cbu || null,
          };
        } catch {
          // swallow — fake CBU stays until admin syncs it
        }
      }

      res.status(201).json({ ...aCuentaPublica(enriched.rows[0]), centralBank });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

    res.json(result.rows.map(aRolPublico));
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

    res.json(result.rows.map(aDestinatarioPublico));
  })
);

router.get(
  '/personas/:id/transacciones',
  validate(paramsSchema, 'params'),
  asyncHandler(async (req, res) => {
    assertCanAccessPersona(req, req.params.id);

    const result = await pool.query(
      `SELECT t.*,
              tt.nombre AS tipo_transaccion_nombre,
              origen.numero_cuenta AS cuenta_origen_numero,
              destino.numero_cuenta AS cuenta_destino_numero
       FROM transacciones t
       JOIN tipos_transaccion tt ON tt.id = t.tipo_transaccion_id
       LEFT JOIN cuentas origen ON origen.id = t.cuenta_origen_id
       LEFT JOIN cuentas destino ON destino.id = t.cuenta_destino_id
       WHERE origen.persona_id = $1 OR destino.persona_id = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [req.params.id]
    );

    res.json(result.rows.map(aTransaccionPublica));
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

    res.json(result.rows.map(aTransaccionPublica));
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
