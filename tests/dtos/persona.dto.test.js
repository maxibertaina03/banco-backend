import { describe, it, expect } from 'vitest';
import { aPersonaPublica, aOpcionDePersona } from '../../src/dtos/persona.dto.js';

describe('aPersonaPublica', () => {
  it('devuelve null si la fila es null o undefined', () => {
    expect(aPersonaPublica(null)).toBeNull();
    expect(aPersonaPublica(undefined)).toBeNull();
  });

  it('mapea los campos públicos esperados', () => {
    const row = {
      id: 'p1',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@example.com',
      dni: '12345678',
      telefono: '+541112345678',
      fecha_nacimiento: '1990-01-01',
      perfil_completo: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };

    expect(aPersonaPublica(row)).toEqual(row);
  });

  it('normaliza campos opcionales ausentes a null', () => {
    const row = {
      id: 'p1',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@example.com',
    };

    const result = aPersonaPublica(row);
    expect(result.dni).toBeNull();
    expect(result.telefono).toBeNull();
    expect(result.fecha_nacimiento).toBeNull();
    expect(result.perfil_completo).toBe(false);
  });

  it('no expone columnas extras de la BD', () => {
    const row = {
      id: 'p1',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@example.com',
      campo_interno_secreto: 'no-debe-salir',
      password_hash: 'hash',
    };

    const result = aPersonaPublica(row);
    expect(result).not.toHaveProperty('campo_interno_secreto');
    expect(result).not.toHaveProperty('password_hash');
  });
});

describe('aOpcionDePersona', () => {
  it('devuelve null si la fila es null', () => {
    expect(aOpcionDePersona(null)).toBeNull();
  });

  it('expone solo los campos mínimos para listados', () => {
    const row = {
      id: 'p1',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@example.com',
      dni: '12345678',
      telefono: '+541112345678',
      fecha_nacimiento: '1990-01-01',
      perfil_completo: true,
    };

    const result = aOpcionDePersona(row);
    expect(result).toEqual({
      id: 'p1',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@example.com',
      dni: '12345678',
      telefono: '+541112345678',
    });
    expect(result).not.toHaveProperty('fecha_nacimiento');
    expect(result).not.toHaveProperty('perfil_completo');
  });
});
