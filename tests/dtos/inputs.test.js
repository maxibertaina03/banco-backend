import { describe, it, expect } from 'vitest';
import {
  normalizePersonaInput,
  normalizeCuentaInput,
  normalizeDestinatarioInput,
  normalizeUsuarioInput,
} from '../../src/dtos/inputs.js';

describe('normalizePersonaInput', () => {
  it('lowercase + trim del email', () => {
    const result = normalizePersonaInput({
      nombre: 'Juan',
      email: '  JUAN@Example.COM  ',
    });
    expect(result.email).toBe('juan@example.com');
  });

  it('descarta claves no permitidas (whitelist defensivo)', () => {
    const result = normalizePersonaInput({
      nombre: 'Juan',
      is_admin: true,
      campo_random: 'hack',
    });
    expect(result).not.toHaveProperty('is_admin');
    expect(result).not.toHaveProperty('campo_random');
    expect(result.nombre).toBe('Juan');
  });

  it('no introduce undefined para campos no enviados (PUT parcial OK)', () => {
    const result = normalizePersonaInput({ nombre: 'Juan' });
    expect(Object.keys(result)).toEqual(['nombre']);
  });

  it('respeta null explícito (vs undefined)', () => {
    const result = normalizePersonaInput({ nombre: 'Juan', telefono: null });
    expect(result.telefono).toBeNull();
  });
});

describe('normalizeCuentaInput', () => {
  it('convierte alias vacío o whitespace a null', () => {
    expect(normalizeCuentaInput({ alias: '   ' }).alias).toBeNull();
    expect(normalizeCuentaInput({ alias: '' }).alias).toBeNull();
  });

  it('trimea alias con contenido válido', () => {
    expect(normalizeCuentaInput({ alias: '  mi.alias  ' }).alias).toBe('mi.alias');
  });

  it('preserva valores numéricos como están', () => {
    const result = normalizeCuentaInput({ saldo: '1500.50' });
    expect(result.saldo).toBe('1500.50');
  });
});

describe('normalizeDestinatarioInput', () => {
  it('aplica misma normalización de alias que cuentas', () => {
    expect(normalizeDestinatarioInput({ alias: '   ' }).alias).toBeNull();
    expect(normalizeDestinatarioInput({ alias: ' x ' }).alias).toBe('x');
  });
});

describe('normalizeUsuarioInput', () => {
  it('mantiene clerk_id (es input válido para admin)', () => {
    const result = normalizeUsuarioInput({
      persona_id: 'p1',
      clerk_id: 'user_xyz',
      activo: true,
    });
    expect(result.clerk_id).toBe('user_xyz');
  });

  it('descarta campos no permitidos', () => {
    const result = normalizeUsuarioInput({
      persona_id: 'p1',
      clerk_id: 'user_xyz',
      is_admin: true,
    });
    expect(result).not.toHaveProperty('is_admin');
  });
});
