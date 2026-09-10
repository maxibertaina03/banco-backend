const pool = require('../db/pool');
const HttpError = require('../utils/http-error');
const { esUsuarioInterno } = require('../utils/access-control');

function restrictQueryToCurrentPersona(field = 'persona_id') {
  return (req, _res, next) => {
    if (esUsuarioInterno(req.usuarioActual)) {
      return next();
    }

    if (req.query[field] && req.query[field] !== req.usuarioActual.persona_id) {
      return next(new HttpError(403, 'No puedes consultar recursos de otra persona.'));
    }

    req.query[field] = req.usuarioActual.persona_id;
    return next();
  };
}

function injectCurrentPersona(field = 'persona_id') {
  return (req, _res, next) => {
    if (esUsuarioInterno(req.usuarioActual)) {
      return next();
    }

    if (req.body[field] && req.body[field] !== req.usuarioActual.persona_id) {
      return next(new HttpError(403, 'No puedes crear recursos para otra persona.'));
    }

    req.body[field] = req.usuarioActual.persona_id;
    return next();
  };
}

function requireOwnershipByEntity(table, ownerField = 'persona_id') {
  return async (req, _res, next) => {
    if (esUsuarioInterno(req.usuarioActual)) {
      return next();
    }

    try {
      const result = await pool.query(`SELECT ${ownerField} FROM ${table} WHERE id = $1`, [req.params.id]);

      if (result.rowCount === 0) {
        return next(new HttpError(404, `No existe el recurso en ${table} con id ${req.params.id}.`));
      }

      if (result.rows[0][ownerField] !== req.usuarioActual.persona_id) {
        return next(new HttpError(403, 'No puedes acceder a recursos de otra persona.'));
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  injectCurrentPersona,
  requireOwnershipByEntity,
  restrictQueryToCurrentPersona,
};
