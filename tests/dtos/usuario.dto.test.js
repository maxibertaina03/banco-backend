import { describe, it, expect } from 'vitest';
import { toPublicUsuario } from '../../src/dtos/usuario.dto.js';

describe('toPublicUsuario', () => {
  it('devuelve null si la fila es null', () => {
    expect(toPublicUsuario(null)).toBeNull();
  });

  it('NO expone clerk_id (identificador interno del IdP)', () => {
    const row = {
      id: 'u1',
      persona_id: 'p1',
      clerk_id: 'user_clerk_xxx',
      activo: true,
      created_at: '2026-01-01T00:00:00Z',
    };

    const result = toPublicUsuario(row);
    expect(result).not.toHaveProperty('clerk_id');
    expect(result.id).toBe('u1');
    expect(result.persona_id).toBe('p1');
    expect(result.activo).toBe(true);
  });
});
