const realCentralBankService = require('./central-bank-service');
const realCentralBankSimulado = require('./central-bank-simulado');

/**
 * Cuál Banco Central le toca a esta operación.
 *
 * Las sesiones demo no pueden salir al Central de verdad: es un ambiente
 * compartido con todo el curso y la consigna dice que el usuario de prueba no
 * debe impactar "en el dinero real o en algo del banco". Pero tampoco queremos
 * una segunda implementación del banco para el demo, así que el código es uno
 * solo y lo único que cambia es a qué Central le habla.
 *
 * Por qué se resuelve con el `usuarioActual` y no con una variable de entorno o
 * un `AsyncLocalStorage`: `usuarioActual` ya viaja hasta estos services en cada
 * operación, así que la decisión se toma con lo que ya está a mano. Un
 * AsyncLocalStorage centralizaría mejor, pero agrega maquinaria y hace los
 * tests más opacos.
 *
 * Ojo con el caso `undefined`: igual que `puedeOperarSobrePersona` en
 * utils/access-control.js, un `usuarioActual` ausente significa "llamada
 * interna del backend" —las tareas de fondo, los scripts— y ésas sí van al
 * Central de verdad.
 */
function crearSelectorDeCentral({
  real = realCentralBankService,
  simulado = realCentralBankSimulado,
} = {}) {
  return function elCentral(usuarioActual) {
    return usuarioActual?.es_demo ? simulado : real;
  };
}

const elCentral = crearSelectorDeCentral();

module.exports = { elCentral, crearSelectorDeCentral };
