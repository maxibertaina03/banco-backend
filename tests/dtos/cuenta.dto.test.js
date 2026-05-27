import { describe, it, expect } from 'vitest';
import { toPublicCuenta } from '../../src/dtos/cuenta.dto.js';

describe('toPublicCuenta', () => {
  it('devuelve null si la fila es null', () => {
    expect(toPublicCuenta(null)).toBeNull();
  });

  it('mapea campos base sin metadata de JOIN', () => {
    const row = {
      id: 'c1',
      persona_id: 'p1',
      tipo_cuenta_id: 'tc1',
      numero_cuenta: '123456789012',
      cbu: '1'.repeat(22),
      alias: 'mi.alias',
      saldo: '1500.50',
      activa: true,
      banco_central_registrada: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };

    const result = toPublicCuenta(row);
    expect(result).toEqual(row);
    expect(result).not.toHaveProperty('tipo_cuenta_nombre');
  });

  it('incluye campos de JOIN cuando están presentes', () => {
    const row = {
      id: 'c1',
      persona_id: 'p1',
      tipo_cuenta_id: 'tc1',
      numero_cuenta: '123456789012',
      cbu: '1'.repeat(22),
      alias: 'mi.alias',
      saldo: '1500',
      activa: true,
      banco_central_registrada: false,
      tipo_cuenta_nombre: 'Caja de Ahorro',
      tipo_cuenta_descripcion: 'Caja de ahorro en pesos',
    };

    const result = toPublicCuenta(row);
    expect(result.tipo_cuenta_nombre).toBe('Caja de Ahorro');
    expect(result.tipo_cuenta_descripcion).toBe('Caja de ahorro en pesos');
  });

  it('normaliza alias ausente a null', () => {
    const row = {
      id: 'c1',
      persona_id: 'p1',
      tipo_cuenta_id: 'tc1',
      numero_cuenta: '123',
      cbu: '1'.repeat(22),
      saldo: '0',
      activa: true,
      banco_central_registrada: false,
    };

    expect(toPublicCuenta(row).alias).toBeNull();
  });
});
