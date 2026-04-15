const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { buildFilters, buildInsertQuery, buildUpdateQuery } = require('../utils/sql');

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

async function create(entityConfig, payload) {
  const query = buildInsertQuery(entityConfig.table, payload);
  const result = await pool.query(query);
  return result.rows[0];
}

async function update(entityConfig, id, payload) {
  await getById(entityConfig, id);

  const query = buildUpdateQuery(entityConfig.table, id, payload);
  const result = await pool.query(query);
  return result.rows[0];
}

async function remove(entityConfig, id) {
  const result = await pool.query(`DELETE FROM ${entityConfig.table} WHERE id = $1 RETURNING *`, [id]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
  }

  return result.rows[0];
}

module.exports = {
  create,
  getById,
  list,
  remove,
  update,
};
