const HttpError = require('../utils/http-error');

/**
 * Valida una parte del request contra un schema y la reemplaza por el valor ya
 * convertido (números coerced, defaults aplicados, strings con trim).
 *
 * Ojo con `query`: en Express 5 `req.query` es una propiedad de sólo lectura
 * (un getter que parsea la URL a demanda). Asignarle no lanza error, pero
 * tampoco hace nada, y el handler sigue recibiendo los strings crudos. Eso
 * dejaba sin efecto toda la paginación: pedir `?limit=100` devolvía 20 igual,
 * porque el service veía el string "100" y no un número. Por eso acá se
 * redefine la propiedad en vez de asignarla.
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(new HttpError(400, 'Datos inválidos.', result.error.flatten()));
    }

    if (source === 'query') {
      Object.defineProperty(req, 'query', {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } else {
      req[source] = result.data;
    }

    return next();
  };
}

module.exports = validate;
