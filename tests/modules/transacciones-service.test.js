// Tests del service de transacciones usando Dependency Injection.
// El service expone `createTransaccionesService({ pool, centralBankService,
// writeAuditLog })` que permite inyectar mocks sin tocar el sistema de
// mocks de módulos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import HttpError from '../../src/utils/http-error.js';

const { createTransaccionesService } = await import('../../src/modules/transacciones-service.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

// `roles` debe ser un array de strings: así lo consume `hasAnyRole` en
// access-control.js (el middleware de auth normaliza los roles del usuario
// autenticado a strings antes de poblar `req.currentUser`).
const internalUser = { id: 'u-admin', persona_id: 'p-admin', roles: ['admin'] };
const clientUser = { id: 'u-1', persona_id: 'p-1', roles: ['cliente'] };

// Construye un set de mocks listo para inyectar en createTransaccionesService.
function buildMocks() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  const centralBankService = {
    createTransaction: vi.fn(),
    findPersonByAlias: vi.fn(),
    findPersonByCbu: vi.fn(),
    extractCentralCbu: vi.fn((data) => data?.cbu ?? null),
    extractCentralTransactionId: vi.fn((data) => data?.transactionId ?? null),
    syncIncomingTransactions: vi.fn(),
  };
  const writeAuditLog = vi.fn().mockResolvedValue(undefined);

  return { pool, mockClient, centralBankService, writeAuditLog };
}

function buildService(deps) {
  return createTransaccionesService(deps);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listForUser ─────────────────────────────────────────────────────────────

describe('listForUser', () => {
  it('usuario interno: consulta sin filtro de persona', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] });
    const service = buildService({ pool, ...rest });

    const result = await service.listForUser(internalUser);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).toContain('SELECT * FROM transacciones');
    expect(result).toEqual([{ id: 't1' }, { id: 't2' }]);
  });

  it('cliente: consulta filtrando por persona_id', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    const service = buildService({ pool, ...rest });

    await service.listForUser(clientUser);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('origen.persona_id = $1 OR destino.persona_id = $1');
    expect(params).toEqual(['p-1']);
  });
});

// ── getByIdForUser ──────────────────────────────────────────────────────────

describe('getByIdForUser', () => {
  it('lanza 404 si no se encuentra', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService({ pool, ...rest });

    await expect(service.getByIdForUser('t-x', clientUser)).rejects.toMatchObject({ status: 404 });
  });

  it('devuelve la transacción si existe', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 't1', monto: '100' }] });
    const service = buildService({ pool, ...rest });

    const result = await service.getByIdForUser('t1', clientUser);
    expect(result).toEqual({ id: 't1', monto: '100' });
  });
});

// ── resolveRecipient ────────────────────────────────────────────────────────

describe('resolveRecipient', () => {
  it('consulta Brocoly por alias y normaliza la respuesta', async () => {
    const mocks = buildMocks();
    mocks.centralBankService.findPersonByAlias.mockResolvedValueOnce({
      alias: 'juan.alias',
      cbu: '1'.repeat(22),
      nombre: 'Juan',
      apellido: 'Pérez',
      bankName: 'Banco Test',
    });
    const service = buildService(mocks);

    const result = await service.resolveRecipient({ alias: 'juan.alias' });

    expect(mocks.centralBankService.findPersonByAlias).toHaveBeenCalledWith('juan.alias');
    expect(mocks.centralBankService.findPersonByCbu).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alias: 'juan.alias',
      cbu: '1'.repeat(22),
      titular: 'Juan Pérez',
      banco: 'Banco Test',
    });
  });

  it('consulta Brocoly por cbu si no se pasa alias', async () => {
    const mocks = buildMocks();
    const cbu = '2'.repeat(22);
    mocks.centralBankService.findPersonByCbu.mockResolvedValueOnce({
      cbu,
      nombre: 'María',
      apellido: 'García',
    });
    const service = buildService(mocks);

    const result = await service.resolveRecipient({ cbu });

    expect(mocks.centralBankService.findPersonByCbu).toHaveBeenCalledWith(cbu);
    expect(result.titular).toBe('María García');
  });

  it('cachea por TTL: segunda llamada idéntica no pega a Brocoly', async () => {
    const mocks = buildMocks();
    mocks.centralBankService.findPersonByAlias.mockResolvedValueOnce({
      alias: 'cache.test',
      cbu: '3'.repeat(22),
      nombre: 'A',
      apellido: 'B',
    });
    const service = buildService(mocks);

    await service.resolveRecipient({ alias: 'cache.test' });
    await service.resolveRecipient({ alias: 'cache.test' });

    expect(mocks.centralBankService.findPersonByAlias).toHaveBeenCalledOnce();
  });
});

// ── createContractTransfer ──────────────────────────────────────────────────

describe('createContractTransfer', () => {
  // Configura las respuestas del client.query() en el orden que las invoca
  // el service durante una transferencia.
  function setupTransferQueries(mockClient, { origin, insertedRow }) {
    let cbuCallCount = 0;
    mockClient.query.mockImplementation((sqlOrConfig) => {
      const text = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text || '';

      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('WHERE c.cbu = $1')) {
        cbuCallCount += 1;
        // primer call = origen, segundo = destino (interbancaria → null)
        if (cbuCallCount === 1) return Promise.resolve({ rows: origin ? [origin] : [] });
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('FROM tipos_transaccion')) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'tt-transferencia' }] });
      }
      if (text.includes('FROM tipos_cuenta')) {
        return Promise.resolve({ rows: [{ limite_transferencia: null }] });
      }
      if (text.startsWith('UPDATE cuentas SET saldo')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.startsWith('INSERT INTO transacciones')) {
        return Promise.resolve({ rows: [insertedRow] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('happy path: aprueba transferencia y devuelve statusCode 201', async () => {
    const mocks = buildMocks();
    const origin = {
      id: 'c-origin',
      cbu: '1'.repeat(22),
      saldo: '5000',
      activa: true,
      persona_id: 'p-1',
      tipo_cuenta_id: 'tc-1',
      nombre: 'Juan',
      apellido: 'Pérez',
    };
    setupTransferQueries(mocks.mockClient, {
      origin,
      insertedRow: { id: 'tx-1', estado: 'completada', monto: '100' },
    });
    mocks.centralBankService.createTransaction.mockResolvedValueOnce({
      data: { transactionId: 'central-tx-1', cbu: '9'.repeat(22) },
    });
    const service = buildService(mocks);

    const result = await service.createContractTransfer({
      cbuOrigen: origin.cbu,
      cbuDestino: '9'.repeat(22),
      importe: 100,
      saldoOrigen: 5000,
      currentUser: clientUser,
      ipAddress: '127.0.0.1',
    });

    expect(result.statusCode).toBe(201);
    expect(result.stateLabel).toBe('aprobada');
    expect(result.transaction.id).toBe('tx-1');
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce();
  });

  it('rechazada por saldo insuficiente (422 del banco central): statusCode 422', async () => {
    const mocks = buildMocks();
    const origin = {
      id: 'c-origin',
      cbu: '1'.repeat(22),
      saldo: '50',
      activa: true,
      persona_id: 'p-1',
      tipo_cuenta_id: 'tc-1',
      nombre: 'Juan',
      apellido: 'Pérez',
    };
    setupTransferQueries(mocks.mockClient, {
      origin,
      insertedRow: { id: 'tx-2', estado: 'rechazada', monto: '1000' },
    });
    const err = new HttpError(422, 'Saldo insuficiente');
    err.details = { centralBank: { transactionId: 'central-rejected', cbu: '9'.repeat(22) } };
    mocks.centralBankService.createTransaction.mockRejectedValueOnce(err);
    const service = buildService(mocks);

    const result = await service.createContractTransfer({
      cbuOrigen: origin.cbu,
      cbuDestino: '9'.repeat(22),
      importe: 1000,
      saldoOrigen: 50,
      currentUser: clientUser,
      ipAddress: '127.0.0.1',
    });

    expect(result.statusCode).toBe(422);
    expect(result.stateLabel).toBe('rechazada');
  });

  it('lanza 404 si el CBU origen no existe localmente', async () => {
    const mocks = buildMocks();
    setupTransferQueries(mocks.mockClient, {
      origin: null,
      insertedRow: { id: 'never' },
    });
    const service = buildService(mocks);

    await expect(
      service.createContractTransfer({
        cbuOrigen: '0'.repeat(22),
        cbuDestino: '9'.repeat(22),
        importe: 100,
        saldoOrigen: 100,
        currentUser: clientUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rollback si una query falla: COMMIT no se llama', async () => {
    const mocks = buildMocks();
    mocks.mockClient.query.mockImplementation((sql) => {
      const text = typeof sql === 'string' ? sql : sql?.text || '';
      if (text === 'BEGIN' || text === 'ROLLBACK') return Promise.resolve({ rows: [] });
      if (text === 'COMMIT') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('DB error simulado'));
    });
    const service = buildService(mocks);

    await expect(
      service.createContractTransfer({
        cbuOrigen: '1'.repeat(22),
        cbuDestino: '9'.repeat(22),
        importe: 100,
        saldoOrigen: 100,
        currentUser: clientUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toThrow('DB error simulado');

    const queries = mocks.mockClient.query.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0]?.text
    );
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(mocks.mockClient.release).toHaveBeenCalledOnce();
  });
});

// ── createDeposit ───────────────────────────────────────────────────────────

describe('createDeposit', () => {
  function setupDepositQueries(mockClient, { destination, insertedRow }) {
    mockClient.query.mockImplementation((sqlOrConfig) => {
      const text = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text || '';

      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) {
        return Promise.resolve({ rows: [] });
      }
      // getLocalAccountById (destino)
      if (text.includes('WHERE c.id = $1') && text.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: destination ? [destination] : [] });
      }
      if (text.includes("lower(nombre) = 'deposito'")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'tt-deposito' }] });
      }
      if (text.startsWith('UPDATE cuentas SET saldo')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.startsWith('INSERT INTO transacciones')) {
        return Promise.resolve({ rows: [insertedRow] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('happy path: acredita el saldo y registra la transacción', async () => {
    const mocks = buildMocks();
    const destination = {
      id: 'c-1',
      cbu: '1'.repeat(22),
      saldo: '1000',
      activa: true,
      persona_id: 'p-1',
      nombre: 'Juan',
      apellido: 'Pérez',
    };
    setupDepositQueries(mocks.mockClient, {
      destination,
      insertedRow: {
        id: 'tx-deposit-1',
        estado: 'completada',
        canal: 'deposito_efectivo',
        monto: '500',
      },
    });
    const service = buildService(mocks);

    const result = await service.createDeposit({
      cuenta_destino_id: 'c-1',
      monto: 500,
      descripcion: 'Depósito sucursal centro',
      currentUser: internalUser,
      ipAddress: '127.0.0.1',
    });

    expect(result.transaction.id).toBe('tx-deposit-1');
    expect(result.destinationName).toBe('Juan Pérez');
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce();

    // Verifica que se haya hecho UPDATE de saldo con el monto correcto.
    const updateCalls = mocks.mockClient.query.mock.calls.filter((c) =>
      (typeof c[0] === 'string' ? c[0] : c[0]?.text || '').startsWith('UPDATE cuentas SET saldo')
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual([500, 'c-1']);
  });

  it('rechaza monto = 0 con 400', async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await expect(
      service.createDeposit({
        cuenta_destino_id: 'c-1',
        monto: 0,
        currentUser: internalUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  it('rechaza monto negativo con 400', async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await expect(
      service.createDeposit({
        cuenta_destino_id: 'c-1',
        monto: -100,
        currentUser: internalUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404 si la cuenta destino no existe', async () => {
    const mocks = buildMocks();
    setupDepositQueries(mocks.mockClient, {
      destination: null,
      insertedRow: { id: 'never' },
    });
    const service = buildService(mocks);

    await expect(
      service.createDeposit({
        cuenta_destino_id: 'c-ghost',
        monto: 100,
        currentUser: internalUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('400 si la cuenta destino está desactivada', async () => {
    const mocks = buildMocks();
    setupDepositQueries(mocks.mockClient, {
      destination: {
        id: 'c-1',
        cbu: '1'.repeat(22),
        saldo: '0',
        activa: false,
        nombre: 'Juan',
        apellido: 'Pérez',
      },
      insertedRow: { id: 'never' },
    });
    const service = buildService(mocks);

    await expect(
      service.createDeposit({
        cuenta_destino_id: 'c-1',
        monto: 100,
        currentUser: internalUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rollback si falla el INSERT: COMMIT no se llama', async () => {
    const mocks = buildMocks();
    let phase = 'init';
    mocks.mockClient.query.mockImplementation((sqlOrConfig) => {
      const text = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text || '';
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return Promise.resolve({ rows: [] });
      if (text.includes('WHERE c.id = $1') && text.includes('FOR UPDATE')) {
        return Promise.resolve({
          rows: [{ id: 'c-1', cbu: '1'.repeat(22), activa: true, nombre: 'J', apellido: 'P' }],
        });
      }
      if (text.includes("lower(nombre) = 'deposito'")) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 'tt-deposito' }] });
      }
      if (text.startsWith('UPDATE cuentas SET saldo')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.startsWith('INSERT INTO transacciones')) {
        phase = 'inserting';
        return Promise.reject(new Error('insert falló'));
      }
      return Promise.resolve({ rows: [] });
    });
    const service = buildService(mocks);

    await expect(
      service.createDeposit({
        cuenta_destino_id: 'c-1',
        monto: 100,
        currentUser: internalUser,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toThrow('insert falló');

    const queries = mocks.mockClient.query.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0]?.text
    );
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(phase).toBe('inserting');
  });
});
