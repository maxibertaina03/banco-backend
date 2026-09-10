import { describe, it, expect } from 'vitest';
import { aCuentaPublica } from '../../src/dtos/cuenta.dto.js';

describe('aCuentaPublica', () => {
  it('devuelve null si la fila es null', () => {
    expect(aCuentaPublica(null)).toBeNull();
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

    const result = aCuentaPublica(row);
    // El importe sale como number: la columna NUMERIC llega como string
    // desde Postgres y el DTO la convierte en el borde del API.
    // `moneda` y `principal` tienen default para las filas que vienen de
    // queries viejas que todavía no seleccionan esas columnas.
    expect(result).toEqual({
      ...row,
      saldo: Number(row.saldo),
      moneda: 'ARS',
      principal: false,
    });
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

    const result = aCuentaPublica(row);
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

    expect(aCuentaPublica(row).alias).toBeNull();
  });

  it('respeta moneda y principal cuando la fila los trae', () => {
    const row = {
      id: 'c2',
      persona_id: 'p1',
      tipo_cuenta_id: 'tc1',
      numero_cuenta: '001948123456',
      cbu: '2'.repeat(22),
      alias: 'juan.perez.usd',
      saldo: '0',
      moneda: 'USD',
      principal: false,
      activa: true,
      banco_central_registrada: true,
      created_at: '2026-09-08T00:00:00Z',
      updated_at: '2026-09-08T00:00:00Z',
    };

    const result = aCuentaPublica(row);
    expect(result.moneda).toBe('USD');
    expect(result.principal).toBe(false);
    expect(result.saldo).toBe(0);
  });
});
