const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { buildFilters, buildInsertQuery, buildUpdateQuery } = require('../utils/sql');
const { generarCbu, generarNumeroDeCuenta, normalizarMonedaDeCuenta } = require('../utils/cuentas');

async function listar(entityConfig, queryParams = {}) {
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

async function obtenerPorId(entityConfig, id) {
  const result = await pool.query(`SELECT ${entityConfig.select} FROM ${entityConfig.table} WHERE id = $1`, [id]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
  }

  return result.rows[0];
}

async function crear(entityConfig, payload) {
  const payloadNormalizado = { ...payload };

  if (entityConfig.table === 'cuentas') {
    const moneda = normalizarMonedaDeCuenta(payloadNormalizado.moneda ?? 'ARS');
    payloadNormalizado.moneda = moneda;

    if (!payloadNormalizado.numero_cuenta) {
      payloadNormalizado.numero_cuenta = generarNumeroDeCuenta(moneda);
    }

    if (!payloadNormalizado.cbu) {
      payloadNormalizado.cbu = generarCbu(moneda);
    }

    if (payloadNormalizado.saldo === undefined) {
      payloadNormalizado.saldo = '0.00';
    }

    const existingCbu = await pool.query('SELECT id FROM cuentas WHERE cbu = $1 LIMIT 1', [payloadNormalizado.cbu]);
    if (existingCbu.rowCount > 0) {
      throw new HttpError(409, 'Ya existe una cuenta con ese CBU.');
    }

    const cuentaExistente = await pool.query(
      'SELECT id FROM cuentas WHERE persona_id = $1 AND moneda = $2 LIMIT 1',
      [payloadNormalizado.persona_id, moneda]
    );

    if (cuentaExistente.rowCount > 0) {
      throw new HttpError(409, `La persona ya tiene una cuenta en ${moneda}.`);
    }
  }

  const query = buildInsertQuery(entityConfig.table, payloadNormalizado);
  const result = await pool.query(query);
  return result.rows[0];
}

async function actualizar(entityConfig, id, payload) {
  await obtenerPorId(entityConfig, id);

  const query = buildUpdateQuery(entityConfig.table, id, payload);
  const result = await pool.query(query);
  return result.rows[0];
}

async function eliminar(entityConfig, id) {
  const result = await pool.query(`DELETE FROM ${entityConfig.table} WHERE id = $1 RETURNING *`, [id]);

  if (result.rowCount === 0) {
    throw new HttpError(404, `No existe el recurso en ${entityConfig.table} con id ${id}.`);
  }

  return result.rows[0];
}

module.exports = {
  actualizar,
  crear,
  eliminar,
  listar,
  obtenerPorId,
};
