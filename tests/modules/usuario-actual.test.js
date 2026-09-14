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

function archivosJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? archivosJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []
  );
}

describe('El usuario autenticado llega a los services', () => {
  const middleware = readFileSync(join(raiz, 'middlewares/require-active-user.js'), 'utf8');
  const propiedad = middleware.match(/req\.(\w+)\s*=\s*user\b/)?.[1];

  it('el middleware carga el usuario en una propiedad conocida', () => {
    expect(propiedad).toBe('usuarioActual');
  });

  it('ningún archivo lee el usuario de otra propiedad del request', () => {
    const errores = [];
    for (const archivo of archivosJs(raiz)) {
      const texto = readFileSync(archivo, 'utf8');
      for (const m of texto.matchAll(/usuarioActual:\s*req\.(\w+)/g)) {
        if (m[1] !== propiedad) errores.push(`${archivo.replace(raiz, 'src')}: req.${m[1]}`);
      }
      if (/req\.currentUser\b/.test(texto)) errores.push(`${archivo.replace(raiz, 'src')}: req.currentUser`);
    }
    expect(errores).toEqual([]);
  });
});
