// El alias de una cuenta lo cambia su titular.
//
// Existe por un bug real: el portal le mostraba a todos el panel "Actualizar
// alias de cuenta", pero el único endpoint que lo hacía era
// `PUT /central-bank/persons/:cbu/alias`, marcado `internalOnly`. Un cliente
// tocaba el botón y recibía un 403 sobre su propia cuenta.
//
// Estos chequeos son sobre el código fuente, no sobre respuestas HTTP: lo que
// se rompió no fue la lógica del alias sino quién puede llamarla, y eso vive
// en el cableado del router.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const router = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'modules', 'relations-router.js'),
  'utf8'
);

/** El bloque de código de una ruta, desde su path hasta el cierre del handler. */
function bloqueDeRuta(fuente, metodo, ruta) {
  const inicio = fuente.indexOf(`router.${metodo}(\n  '${ruta}'`);
  if (inicio === -1) return null;
  const fin = fuente.indexOf('\n);', inicio);
  return fuente.slice(inicio, fin);
}

describe('PUT /cuentas/:id/alias', () => {
  const bloque = bloqueDeRuta(router, 'put', '/cuentas/:id/alias');

  it('existe: sin esta ruta, un cliente no puede cambiar el alias de su cuenta', () => {
    expect(bloque).not.toBeNull();
  });

  it('valida que la cuenta sea del que llama', () => {
    // `assertCanAccessCuenta` deja pasar a los roles internos y, si no, exige
    // que la cuenta sea de la persona autenticada.
    expect(bloque).toContain('assertCanAccessCuenta');
  });

  it('NO está restringida a roles internos', () => {
    // Este es el chequeo que importa: si alguien vuelve a ponerle
    // `internalOnly` o `requerirRoles`, el panel del portal vuelve a dar 403.
    expect(bloque).not.toMatch(/internalOnly|requerirRoles|adminOnly/);
  });

  it('le pide el alias al Banco Central antes de guardarlo', () => {
    // El alias es único en todo el sistema financiero: si lo guardáramos
    // primero, nuestra base mostraría un alias que nadie puede usar para
    // transferir.
    expect(bloque).toContain('centralBankService.assignAlias');
  });

  it('traduce el alias tomado a un 409 que se entiende', () => {
    expect(bloque).toContain('ya está en uso');
  });
});

describe('el esquema del alias', () => {
  const esquema = router.slice(
    router.indexOf('const aliasDeCuentaSchema'),
    router.indexOf('router.put(\n  \'/cuentas/:id/alias\'')
  );

  it('acepta el mismo juego de caracteres que el Banco Central', () => {
    // Letras, números, puntos y guiones. El guión estaba prometido en el texto
    // del formulario pero faltaba en su expresión regular.
    expect(esquema).toContain('A-Za-z0-9.-');
  });

  it('exige un largo razonable', () => {
    expect(esquema).toMatch(/min\(6/);
    expect(esquema).toMatch(/max\(20/);
  });
});
