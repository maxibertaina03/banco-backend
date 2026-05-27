const { z } = require('zod');

// Schema de paginación para query strings de listados. Coerce porque los
// query params siempre llegan como string. `.passthrough()` permite que
// los filtros adicionales (declarados en entityConfig.allowedFilters) pasen
// sin que zod los descarte.
//
// Límites elegidos:
//  - page: entero positivo (no 0, no negativo). Default 1.
//  - limit: 1..100. Default 20. Cap en 100 evita que un cliente pida 100k
//    filas en una sola request (DoS accidental).
//
// Errores posibles:
//  - "?page=abc"   → 400 ("Expected number, received nan")
//  - "?limit=-1"   → 400 ("Number must be greater than or equal to 1")
//  - "?limit=9999" → 400 ("Number must be less than or equal to 100")
//
// Antes de esto el CRUD genérico hacía `Number(queryParams.page || 1)` que
// devolvía `NaN` silenciosamente para inputs inválidos.

const paginationSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .passthrough();

module.exports = { paginationSchema };
