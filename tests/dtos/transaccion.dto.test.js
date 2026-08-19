import { describe, it, expect } from 'vitest';
import { aTransaccionPublica } from '../../src/dtos/transaccion.dto.js';

describe('aTransaccionPublica', () => {
  it('devuelve null si la fila es null', () => {
    expect(aTransaccionPublica(null)).toBeNull();
  });

  it('mapea los campos base sin JOIN', () => {
    const row = {
      id: 't1',
      tipo_transaccion_id: 'tt1',
      cuenta_origen_id: 'c1',
      cuenta_destino_id: 'c2',
      cbu_origen: '1'.repeat(22),
      cbu_destino: '2'.repeat(22),
      monto: '500.00',
      descripcion: 'Pago alquiler',
      estado: 'completada',
      canal: 'local',
      central_transaction_id: 'central-xyz',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    expect(aTransaccionPublica(row)).toEqual({ ...row, monto: Number(row.monto) });
  });

  it('incluye campos de JOIN cuando están presentes', () => {
    const row = {
      id: 't1',
      tipo_transaccion_id: 'tt1',
      cuenta_origen_id: 'c1',
      cuenta_destino_id: 'c2',
      monto: '500',
      estado: 'completada',
      tipo_transaccion_nombre: 'Transferencia',
      cuenta_origen_numero: '111111',
      cuenta_destino_numero: '222222',
    };

    const result = aTransaccionPublica(row);
    expect(result.tipo_transaccion_nombre).toBe('Transferencia');
    expect(result.cuenta_origen_numero).toBe('111111');
    expect(result.cuenta_destino_numero).toBe('222222');
  });

  it('normaliza campos opcionales ausentes', () => {
    const row = {
      id: 't1',
      tipo_transaccion_id: 'tt1',
      cuenta_origen_id: 'c1',
      cuenta_destino_id: null,
      monto: '100',
      estado: 'pendiente',
    };

    const result = aTransaccionPublica(row);
    expect(result.cbu_origen).toBeNull();
    expect(result.cbu_destino).toBeNull();
    expect(result.descripcion).toBeNull();
    expect(result.canal).toBeNull();
    expect(result.central_transaction_id).toBeNull();
  });
});
