// Verifica que el contrato y la implementación no se separen.
//
// Este test existe por un problema real: al implementar las fases 3 a 5 el
// backend se fue moviendo y el contrato quedó atrás. Gonza construye el
// frontend contra ese YAML, así que una ruta declarada y no implementada le
// hace escribir código contra un 404, y no se entera hasta integrar.
//
// Sólo chequea la FORMA de las rutas, no los bodies: es barato, corre en el CI
// y caza el error que importa.
//
// Excepción: las operaciones marcadas `x-pendiente: true` tienen el contrato
// cerrado pero todavía no se implementaron (servicios y recargas). Se saltean
// en el primer chequeo, y el tercero obliga a sacar la marca apenas la ruta
// existe, para que la excepción no quede para siempre.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';

const raiz = join(import.meta.dirname, '..', '..');

/** Rutas que el backend monta de verdad, leídas del código. */
function rutasImplementadas() {
  const indice = readFileSync(join(raiz, 'src/routes/index.js'), 'utf8');
  const montaje = {};
  for (const linea of indice.split('\n')) {
    const m = linea.match(/router\.use\('([^']+)',\s*(\w+)/);
    if (m) montaje[m[2]] = m[1];
  }

  const archivos = {
    transaccionesRouter: 'transacciones',
    tarjetasRouter: 'tarjetas',
    prestamosRouter: 'prestamos',
    plazosFijosRouter: 'plazos-fijos',
    relationsRouter: 'relations',
    // Todavía no existen: se leen si aparecen.
    serviciosRouter: 'servicios',
    recargasRouter: 'recargas',
  };

  const rutas = new Set();
  for (const [variable, nombre] of Object.entries(archivos)) {
    const prefijo = (montaje[variable] || '') === '/' ? '' : montaje[variable] || '';
    const archivo = join(raiz, `src/modules/${nombre}-router.js`);
    if (!existsSync(archivo)) continue;
    const texto = readFileSync(archivo, 'utf8');
    for (const m of texto.matchAll(/router\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/g)) {
      const ruta = `/api${prefijo}${m[2]}`.replace(/\/$/, '') || '/api';
      rutas.add(`${m[1].toUpperCase()} ${ruta.replace(/:\w+/g, '{x}')}`);
    }
  }
  return rutas;
}

/** Rutas que el contrato declara. Con `pendientes: true`, sólo las marcadas `x-pendiente`. */
function rutasDelContrato({ pendientes = false } = {}) {
  const spec = yaml.parse(readFileSync(join(raiz, 'docs/openapi-banco-orbital.yaml'), 'utf8'));
  const rutas = new Set();
  for (const [ruta, ops] of Object.entries(spec.paths)) {
    for (const metodo of Object.keys(ops)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(metodo)
          && Boolean(ops[metodo]['x-pendiente']) === pendientes) {
        rutas.add(`${metodo.toUpperCase()} ${ruta.replace(/\/$/, '').replace(/\{\w+\}/g, '{x}')}`);
      }
    }
  }
  return rutas;
}

describe('El contrato coincide con lo implementado', () => {
  it('toda ruta del contrato existe en el backend', () => {
    const implementadas = rutasImplementadas();
    const faltantes = [...rutasDelContrato()].filter((r) => !implementadas.has(r));

    // Si esto falla: o se implementa la ruta, o se saca del contrato. Dejarla
    // declarada sin implementar hace que el frontend construya contra un 404.
    expect(faltantes).toEqual([]);
  });

  it('una ruta pendiente que ya se implementó tiene que perder la marca', () => {
    // Si esto falla: borrá `x-pendiente: true` de esa operación en el YAML, en
    // el mismo PR que la implementa.
    const implementadas = rutasImplementadas();
    const yaImplementadas = [...rutasDelContrato({ pendientes: true })].filter((r) => implementadas.has(r));
    expect(yaImplementadas).toEqual([]);
  });

  it('el contrato es un OpenAPI 3.0.3 parseable', () => {
    const spec = yaml.parse(readFileSync(join(raiz, 'docs/openapi-banco-orbital.yaml'), 'utf8'));
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
  });
});
