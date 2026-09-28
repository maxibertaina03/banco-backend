// Qué nivel de tarjeta le corresponde a cada perfil.
//
// Es la regla de negocio más delicada de las tarjetas: define cuánto crédito
// otorga el banco. Antes el límite lo mandaba el cliente en el body.

import { describe, it, expect } from 'vitest';

const { evaluarNiveles, buscarNivel, NIVELES } = await import('../../src/modules/niveles-tarjeta.js');

const nivelesDe = (perfil) => evaluarNiveles(perfil).niveles.filter((n) => n.disponible).map((n) => n.nivel);

describe('evaluarNiveles', () => {
  it('con situación 1 y patrimonio alto, llega a Black', () => {
    const r = evaluarNiveles({ situacion: 1, patrimonio: 20000000 });
    expect(r.nivel_maximo).toBe('black');
    expect(nivelesDe({ situacion: 1, patrimonio: 20000000 })).toEqual(['standard', 'gold', 'platinum', 'black']);
  });

  it('el patrimonio corta el nivel: con 600.000 llega hasta Gold', () => {
    expect(nivelesDe({ situacion: 1, patrimonio: 600000 })).toEqual(['standard', 'gold']);
  });

  it('con situación 2 sólo la Standard, por más patrimonio que tenga', () => {
    expect(nivelesDe({ situacion: 2, patrimonio: 50000000 })).toEqual(['standard']);
  });

  it('situación 3 o peor: ninguna tarjeta de crédito', () => {
    // Es la misma regla que ya bloquea préstamos y apertura de cuentas.
    const r = evaluarNiveles({ situacion: 4, patrimonio: 99999999 });
    expect(r.nivel_maximo).toBeNull();
    expect(r.niveles.every((n) => !n.disponible)).toBe(true);
    expect(r.niveles[0].motivo).toMatch(/Central de Deudores/);
  });

  it('si no se pudo consultar al Central, sólo la de entrada', () => {
    // Mejor quedarse corto que dar un límite alto sin saber si debe en otro banco.
    expect(nivelesDe({ situacion: null, patrimonio: 90000000 })).toEqual(['standard']);
  });

  it('cada motivo explica qué falta, con números', () => {
    const black = evaluarNiveles({ situacion: 1, patrimonio: 600000 }).niveles.find((n) => n.nivel === 'black');
    expect(black.motivo).toMatch(/12\.000\.000/);
    expect(black.motivo).toMatch(/600\.000/);
  });

  it('los niveles van de menor a mayor límite y no exponen los umbrales como reglas sueltas', () => {
    const limites = NIVELES.map((n) => n.limite);
    expect(limites).toEqual([...limites].sort((a, b) => a - b));
    expect(buscarNivel('BLACK').nombre).toBe('Black');
    expect(buscarNivel('inexistente')).toBeNull();
  });
});
