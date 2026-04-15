function buildInsertQuery(table, payload) {
  const keys = Object.keys(payload);
  const values = Object.values(payload);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

  return {
    text: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values,
  };
}

function buildUpdateQuery(table, id, payload) {
  const keys = Object.keys(payload);
  const values = Object.values(payload);
  const assignments = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');

  return {
    text: `UPDATE ${table} SET ${assignments} WHERE id = $${keys.length + 1} RETURNING *`,
    values: [...values, id],
  };
}

function buildFilters(allowedFilters, queryParams, startIndex = 1) {
  const clauses = [];
  const values = [];
  let nextIndex = startIndex;

  for (const key of allowedFilters) {
    const value = queryParams[key];
    if (value !== undefined) {
      clauses.push(`${key} = $${nextIndex}`);
      values.push(value);
      nextIndex += 1;
    }
  }

  return { clauses, values, nextIndex };
}

module.exports = {
  buildFilters,
  buildInsertQuery,
  buildUpdateQuery,
};
