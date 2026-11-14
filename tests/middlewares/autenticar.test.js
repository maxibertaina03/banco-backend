// La puerta de /api: acepta el token de Clerk y el de una sesión de prueba.
//
// Lo que este test cuida, en orden de gravedad:
//
//  1. Que el camino de Clerk siga funcionando exactamente igual. El modo demo
//     no puede costarle nada a los clientes reales.
//  2. Que ante un token de prueba inválido el middleware llame a `next(error)`
//     y NUNCA a `next()` pelado. Un `next()` sin `req.usuarioActual` convierte
//     el token en un pase de superusuario, porque `puedeOperarSobrePersona`
//     trata al usuario ausente como una llamada interna del backend
//     (utils/access-control.js).
//  3. Que una sesión de prueba sea siempre y sólo `cliente`.

import { describe, it, expect, vi } from 'vitest';

const { crearAutenticar } = await import('../../src/middlewares/autenticar.js');
const { PREFIJO_TOKEN } = await import('../../src/modules/demo-service.js');

const SESION = {
  id: 'sesion-1',
  persona_id: 'persona-demo',
  usuario_id: 'usuario-demo',
  clerk_id: `${PREFIJO_TOKEN}abc`,
  activo: true,
  created_at: new Date('2026-11-13'),
  nombre: 'Visitante',
  apellido: 'de prueba',
  email: 'demo-abc@orbital.net.ar',
  perfil_completo: true,
};

function armar({ sesion = SESION } = {}) {
  const demoService = { buscarSesionViva: vi.fn().mockResolvedValue(sesion) };
  const requireActiveUser = vi.fn((req, _res, next) => {
    req.usuarioActual = { id: 'u-real', persona_id: 'p-real', roles: ['cliente'] };
    next();
  });
  return {
    demoService,
    requireActiveUser,
    autenticar: crearAutenticar({ demoService, requireActiveUser }),
  };
}

const pedido = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('entrada con token de prueba', () => {
  it('arma un usuarioActual con la misma forma que el camino normal', async () => {
    const { autenticar } = armar();
    const req = pedido(`${PREFIJO_TOKEN}unoquesirve`);
    const next = vi.fn();

    await autenticar(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    // Las claves que el resto del sistema lee de req.usuarioActual.
    for (const campo of ['id', 'persona_id', 'clerk_id', 'activo', 'nombre', 'apellido', 'email', 'perfil_completo', 'roles']) {
      expect(req.usuarioActual, `falta ${campo}`).toHaveProperty(campo);
    }
    expect(req.usuarioActual.persona_id).toBe('persona-demo');
    expect(req.esDemo).toBe(true);
  });

  it('la marca es_demo viaja, que es lo que desvía al Central simulado', async () => {
    const { autenticar } = armar();
    const req = pedido(`${PREFIJO_TOKEN}unoquesirve`);
    await autenticar(req, {}, vi.fn());

    expect(req.usuarioActual.es_demo).toBe(true);
  });

  it('el rol es siempre y sólo cliente, venga lo que venga de la base', async () => {
    // Aunque alguien le metiera el rol admin a la persona de prueba en la base,
    // el middleware no lo mira: la lista está escrita en el código.
    const { autenticar } = armar({ sesion: { ...SESION, roles: ['admin', 'tesoreria'] } });
    const req = pedido(`${PREFIJO_TOKEN}unoquesirve`);
    await autenticar(req, {}, vi.fn());

    expect(req.usuarioActual.roles).toEqual(['cliente']);
  });

  it('una sesión vencida o inexistente se rechaza, y NO deja pasar', async () => {
    const { autenticar, demoService } = armar();
    demoService.buscarSesionViva.mockResolvedValue(null);
    const req = pedido(`${PREFIJO_TOKEN}vencido`);
    const next = vi.fn();

    await autenticar(req, {}, next);

    const error = next.mock.calls[0][0];
    expect(error).toBeDefined();
    expect(error.status).toBe(401);
    // Lo que de verdad importa: sin usuarioActual, un next() pelado sería un
    // pase de llamada interna.
    expect(req.usuarioActual).toBeUndefined();
  });
});

describe('el camino de Clerk no se toca', () => {
  it('un token normal ni siquiera consulta las sesiones de prueba', async () => {
    const { autenticar, demoService } = armar();
    const req = pedido('eyJhbGciOiJSUzI1NiJ9.token.de.clerk');

    await autenticar(req, {}, vi.fn()).catch(() => {});

    expect(demoService.buscarSesionViva).not.toHaveBeenCalled();
  });

  it('sin ningún token tampoco entra por la puerta de prueba', async () => {
    const { autenticar, demoService } = armar();
    await autenticar(pedido(null), {}, vi.fn()).catch(() => {});

    expect(demoService.buscarSesionViva).not.toHaveBeenCalled();
  });
});
