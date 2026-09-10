const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { buildFilters, buildInsertQuery, buildUpdateQuery } = require('../utils/sql');
const { escribirLogDeAuditoria } = require('../utils/audit');

// Convención: las entidades pueden declarar `dto` (función fila→respuesta
// pública) y `inputDto` (función body→payload normalizado para SQL). Si la
// entidad no las declara, se devuelve la fila cruda y se inserta el body tal
// cual (comportamiento previo). Esto permite migrar entidades una a una sin
// romper las que aún no tienen DTO.

function applyDto(entityConfig, row) {
  if (!row) return row;
  return entityConfig.dto ? entityConfig.dto(row) : row;
}

function applyInputDto(entityConfig, body) {
  return entityConfig.inputDto ? entityConfig.inputDto(body) : body;
}

async function list(entityConfig, queryParams = {}) {
  // page y limit ya vienen validados y coerced a number por
  // `paginationSchema` en crud-router. Si este service se llama desde otro
  // contexto (sin middleware), aplicamos defaults defensivos.
  const page = typeof queryParams.page === 'number' ? queryParams.page : 1;
  const limit = typeof queryParams.limit === 'number' ? queryParams.limit : 20;
  const offset = (page - 1) * limit;

  const { clauses, values } = buildFilters(entityConfig.allowedFilters, queryParams);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await pool.query({
    text: `SELECT ${entityConfig.select} FROM ${entityConfig.table} ${where} ORDER BY ${entityConfig.orderBy} LIMIT $${
      values.length + 1
    } OFFSET $${values.length + 2}`,
    values: [...values, limit, offset],
  });

  return {
    page,
    limit,
    count: result.rows.length,
    data: result.rows.map((row) => applyDto(entityConfig, row)),
  };
}

async function getById(entityConfig, id) {
  const result = await pool.query(`SELECT ${entityConfig.select} FROM ${entityConfig.table} WHERE id = $1`, [id]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
  }

  return applyDto(entityConfig, result.rows[0]);
}

async function create(entityConfig, payload, auditContext = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalized = applyInputDto(entityConfig, payload);
    const query = buildInsertQuery(entityConfig.table, normalized);
    const result = await client.query(query);
    const created = result.rows[0];

    // payloadDespues queda con la fila cruda: la auditoría es interna y se
    // beneficia de tener todos los campos, incluidos los no expuestos.
    await escribirLogDeAuditoria(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'CREATE',
      entidad: entityConfig.table,
      entidadId: created.id,
      payloadDespues: created,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return applyDto(entityConfig, created);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function update(entityConfig, id, payload, auditContext = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const previousResult = await client.query(
      `SELECT ${entityConfig.select} FROM ${entityConfig.table} WHERE id = $1`,
      [id]
    );

    if (previousResult.rowCount === 0) {
      throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
    }

    const previous = previousResult.rows[0];
    const normalized = applyInputDto(entityConfig, payload);
    const query = buildUpdateQuery(entityConfig.table, id, normalized);
    const result = await client.query(query);
    const updated = result.rows[0];

    await escribirLogDeAuditoria(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'UPDATE',
      entidad: entityConfig.table,
      entidadId: updated.id,
      payloadAntes: previous,
      payloadDespues: updated,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return applyDto(entityConfig, updated);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function remove(entityConfig, id, auditContext = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`DELETE FROM ${entityConfig.table} WHERE id = $1 RETURNING *`, [id]);

    if (result.rowCount === 0) {
      throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
    }

    const deleted = result.rows[0];

    await escribirLogDeAuditoria(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'DELETE',
      entidad: entityConfig.table,
      entidadId: deleted.id,
      payloadAntes: deleted,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return applyDto(entityConfig, deleted);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  create,
  getById,
  list,
  remove,
  update,
};
