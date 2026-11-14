const { clerkAuth, extractToken } = require('./clerk-auth');
const realRequireActiveUser = require('./require-active-user');
const realDemoService = require('../modules/demo-service');
const { PREFIJO_TOKEN } = require('../modules/demo-service');
const HttpError = require('../utils/http-error');

/**
 * La puerta de entrada de /api. Acepta dos credenciales.
 *
 * La normal es Clerk. La otra es un token de sesión de prueba, que entra por el
 * mismo header `Authorization: Bearer` —no por uno propio, porque el CORS de
 * app.js sólo permite Content-Type, Authorization e Idempotency-Key, y un
 * header nuevo quedaría bloqueado en el navegador.
 *
 * Por qué una sola cadena y no un router aparte como el de cobros: el visitante
 * tiene que poder usar TODOS los endpoints, no un subconjunto. Si el demo
 * entrara por otra puerta habría que duplicar las rutas, y entonces lo que se
 * probaría no sería el banco sino una copia del banco. Acá el código es uno
 * solo y lo único distinto es de dónde sale `req.usuarioActual`.
 *
 * Y sale con la MISMA forma en los dos casos —los campos de `usuarios`, cuatro
 * de `personas` y `roles` como array de nombres—, así que todo lo que viene
 * después (ownership, roles, auditoría, idempotencia) funciona sin enterarse.
 */
function crearAutenticar({
  demoService = realDemoService,
  requireActiveUser = realRequireActiveUser,
} = {}) {
  return async function autenticar(req, res, next) {
    const token = extractToken(req);

    if (!token || !token.startsWith(PREFIJO_TOKEN)) {
      // Camino normal, intacto.
      return clerkAuth(req, res, (error) => {
        if (error) return next(error);
        return requireActiveUser(req, res, next);
      });
    }

    try {
      const sesion = await demoService.buscarSesionViva(token);
      if (!sesion) {
        return next(new HttpError(401, 'La sesión de prueba venció o ya se cerró. Escaneá el QR de nuevo.'));
      }

      req.esDemo = true;
      req.demoSesionId = sesion.id;
      req.usuarioActual = {
        id: sesion.usuario_id,
        persona_id: sesion.persona_id,
        clerk_id: sesion.clerk_id,
        activo: sesion.activo,
        created_at: sesion.created_at,
        nombre: sesion.nombre,
        apellido: sesion.apellido,
        email: sesion.email,
        perfil_completo: sesion.perfil_completo,
        // Siempre y únicamente cliente. Que esto esté escrito acá y no venga de
        // la base es a propósito: ni un INSERT equivocado en personas_roles
        // puede darle permisos internos a un visitante.
        roles: ['cliente'],
        // Lo que hace que las operaciones vayan contra el Central simulado.
        es_demo: true,
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = crearAutenticar();
module.exports.crearAutenticar = crearAutenticar;
