// Verifica que los routers le pasen a los services el usuario que el middleware
// realmente carga.
//
// Existe por un bug real: tras el renombre a español, `require-active-user`
// pasó a setear `req.usuarioActual`, pero 16 rutas seguían leyendo
// `req.currentUser`, que quedaba `undefined`. Y `puedeOperarSobrePersona`
// trata a un usuario ausente como una llamada interna: esas rutas dejaban a
// cualquier cliente operar sobre cuentas, tarjetas y préstamos ajenos.
//
// Nada fallaba en los tests de los services porque ahí el usuario se inyecta a
// mano. El error estaba justo en el pegamento entre middleware y router.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..', '..', 'src');

/** El código sin comentarios: un `req.algo` mencionado en un comentario no es una lectura. */
function codigoDe(archivo) {
  return readFileSync(archivo, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function archivosJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? archivosJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []
  );
}

// Propiedades que pone Express, pino-http o el runtime, no nuestro código.
const DEL_FRAMEWORK = new Set([
  'app', 'baseUrl', 'body', 'cookies', 'headers', 'hostname', 'id', 'ip', 'ips', 'log',
  'method', 'originalUrl', 'params', 'path', 'protocol', 'query', 'res', 'route',
  'secure', 'signedCookies', 'socket', 'subdomains', 'url', 'get', 'header', 'is', 'accepts',
]);

describe('Nadie lee una propiedad del request que no exista', () => {
  // El bug de `req.currentUser` y el de `req.clerkUserId` en el chatbot son el
  // mismo: leer del request algo que ningún middleware carga. Queda `undefined`,
  // y según dónde se use termina en un 403 permanente o, peor, en saltarse una
  // validación de dueño. Ninguno de los dos lo agarraban los tests de service,
  // porque ahí el usuario se pasa a mano.
  it('toda propiedad que se lee del request la setea alguien', () => {
    const archivos = archivosJs(raiz);

    const seteadas = new Set();
    for (const archivo of archivos) {
      for (const m of codigoDe(archivo).matchAll(/\breq\.(\w+)\s*=[^=]/g)) {
        seteadas.add(m[1]);
      }
    }

    const errores = [];
    for (const archivo of archivos) {
      for (const m of codigoDe(archivo).matchAll(/\breq\.(\w+)\b/g)) {
        const propiedad = m[1];
        if (!seteadas.has(propiedad) && !DEL_FRAMEWORK.has(propiedad)) {
          errores.push(`${archivo.replace(raiz, 'src')}: req.${propiedad}`);
        }
      }
    }

    expect([...new Set(errores)]).toEqual([]);
  });
});

describe('El usuario autenticado llega a los services', () => {
  const middleware = readFileSync(join(raiz, 'middlewares/require-active-user.js'), 'utf8');
  const propiedad = middleware.match(/req\.(\w+)\s*=\s*user\b/)?.[1];

  it('el middleware carga el usuario en una propiedad conocida', () => {
    expect(propiedad).toBe('usuarioActual');
  });

  it('ningún archivo lee el usuario de otra propiedad del request', () => {
    const errores = [];
    for (const archivo of archivosJs(raiz)) {
      const texto = codigoDe(archivo);
      for (const m of texto.matchAll(/usuarioActual:\s*req\.(\w+)/g)) {
        if (m[1] !== propiedad) errores.push(`${archivo.replace(raiz, 'src')}: req.${m[1]}`);
      }
      if (/req\.currentUser\b/.test(texto)) errores.push(`${archivo.replace(raiz, 'src')}: req.currentUser`);
    }
    expect(errores).toEqual([]);
  });
});
