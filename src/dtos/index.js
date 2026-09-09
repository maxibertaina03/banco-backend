// Barrel export: punto único de entrada para todos los DTOs del backend.
// Uso: const { aPersonaPublica, aCuentaPublica } = require('../dtos');

module.exports = {
  ...require('./persona.dto'),
  ...require('./usuario.dto'),
  ...require('./cuenta.dto'),
  ...require('./transaccion.dto'),
  ...require('./destinatario.dto'),
  ...require('./rol.dto'),
  ...require('./tipo-cuenta.dto'),
  ...require('./tipo-transaccion.dto'),
  ...require('./persona-rol.dto'),
  ...require('./tarjeta.dto'),
  ...require('./prestamo.dto'),
  ...require('./inputs'),
};
