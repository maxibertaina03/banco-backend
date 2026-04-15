const HttpError = require('../utils/http-error');

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(new HttpError(400, 'Datos inválidos.', result.error.flatten()));
    }

    req[source] = result.data;
    return next();
  };
}

module.exports = validate;
