const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { buildFilters, buildInsertQuery, buildUpdateQuery } = require('../utils/sql');
const { writeAuditLog } = require('../utils/audit');

async function list(entityConfig, queryParams = {}) {
  const page = Number(queryParams.page || 1);
  const limit = Math.min(Number(queryParams.limit || 20), 100);
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
    data: result.rows,
  };
}

async function getById(entityConfig, id) {
  const result = await pool.query(`SELECT ${entityConfig.select} FROM ${entityConfig.table} WHERE id = $1`, [id]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
  }

  return result.rows[0];
}

async function create(entityConfig, payload, auditContext = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const query = buildInsertQuery(entityConfig.table, payload);
    const result = await client.query(query);
    const created = result.rows[0];

    await writeAuditLog(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'CREATE',
      entidad: entityConfig.table,
      entidadId: created.id,
      payloadDespues: created,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return created;
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
    const query = buildUpdateQuery(entityConfig.table, id, payload);
    const result = await client.query(query);
    const updated = result.rows[0];

    await writeAuditLog(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'UPDATE',
      entidad: entityConfig.table,
      entidadId: updated.id,
      payloadAntes: previous,
      payloadDespues: updated,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return updated;
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

    await writeAuditLog(client, {
      usuarioId: auditContext.usuarioId,
      accion: 'DELETE',
      entidad: entityConfig.table,
      entidadId: deleted.id,
      payloadAntes: deleted,
      ipAddress: auditContext.ipAddress,
    });

    await client.query('COMMIT');
    return deleted;
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
