// Tests del service de transacciones usando Dependency Injection.
// El service expone `createTransaccionesService({ pool, centralBankService,
// escribirLogDeAuditoria })` que permite inyectar mocks sin tocar el sistema de
// mocks de módulos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import HttpError from '../../src/utils/http-error.js';

const { createTransaccionesService } = await import('../../src/modules/transacciones-service.js');

// ── Fixtures ────────────────────────────────────────────────────────────────

// `roles` debe ser un array de strings: así lo consume `tieneAlgunRol` en
// access-control.js (el middleware de auth normaliza los roles del usuario
// autenticado a strings antes de poblar `req.usuarioActual`).
const usuarioInterno = { id: 'u-admin', persona_id: 'p-admin', roles: ['admin'] };
const usuarioCliente = { id: 'u-1', persona_id: 'p-1', roles: ['cliente'] };

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
    crearTransaccion: vi.fn(),
    findPersonByAlias: vi.fn(),
    findPersonByCbu: vi.fn(),
    extractCentralCbu: vi.fn((data) => data?.cbu ?? null),
    extraerIdTransaccionCentral: vi.fn((data) => data?.idTransaccion ?? null),
    sincronizarTransaccionesEntrantes: vi.fn(),
  };
  const escribirLogDeAuditoria = vi.fn().mockResolvedValue(undefined);
  // Sin este stub, la validación de moneda intentaría consultar el Banco Central
  // de verdad en cada test. Por defecto deja pasar, que es lo que hacía el
  // service antes de que existieran las cuentas en dólares.
  const monedas = {
    resolverMonedaDeCbu: vi.fn().mockResolvedValue(null),
    validarMonedasCompatibles: vi.fn().mockResolvedValue({ verificado: false }),
    validarEntrante: vi.fn().mockResolvedValue({ acreditable: true, motivo: null }),
  };

  return { pool, mockClient, centralBankService, escribirLogDeAuditoria, monedas };
}

function buildService(deps) {
  return createTransaccionesService(deps);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listarParaUsuario ─────────────────────────────────────────────────────────────

describe('listarParaUsuario', () => {
  it('usuario interno: consulta sin filtro de persona', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] });
    const service = buildService({ pool, ...rest });

    const result = await service.listarParaUsuario(usuarioInterno);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query.mock.calls[0][0]).toContain('SELECT * FROM transacciones');
    expect(result).toEqual([{ id: 't1' }, { id: 't2' }]);
  });

  it('cliente: consulta filtrando por persona_id', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    const service = buildService({ pool, ...rest });

    await service.listarParaUsuario(usuarioCliente);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('origen.persona_id = $1 OR destino.persona_id = $1');
    expect(params).toEqual(['p-1']);
  });
});

// ── obtenerPorIdParaUsuario ──────────────────────────────────────────────────────────

describe('obtenerPorIdParaUsuario', () => {
  it('lanza 404 si no se encuentra', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const service = buildService({ pool, ...rest });

    await expect(service.obtenerPorIdParaUsuario('t-x', usuarioCliente)).rejects.toMatchObject({ status: 404 });
  });

  it('devuelve la transacción si existe', async () => {
    const { pool, ...rest } = buildMocks();
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 't1', monto: '100' }] });
    const service = buildService({ pool, ...rest });

    const result = await service.obtenerPorIdParaUsuario('t1', usuarioCliente);
    expect(result).toEqual({ id: 't1', monto: '100' });
  });
});

// ── resolverDestinatario ────────────────────────────────────────────────────────

describe('resolverDestinatario', () => {
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

    const result = await service.resolverDestinatario({ alias: 'juan.alias' });

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

    const result = await service.resolverDestinatario({ cbu });

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

    await service.resolverDestinatario({ alias: 'cache.test' });
    await service.resolverDestinatario({ alias: 'cache.test' });

    expect(mocks.centralBankService.findPersonByAlias).toHaveBeenCalledOnce();
  });
});

// ── crearTransferenciaPorContrato ──────────────────────────────────────────────────

describe('crearTransferenciaPorContrato', () => {
  // Configura las respuestas del client.query() en el orden que las invoca
  // el service durante una transferencia.
  function prepararQueriesDeTransferencia(mockClient, { origin, insertedRow }) {
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
    prepararQueriesDeTransferencia(mocks.mockClient, {
      origin,
      insertedRow: { id: 'tx-1', estado: 'completada', monto: '100' },
    });
    mocks.centralBankService.crearTransaccion.mockResolvedValueOnce({
      data: { idTransaccion: 'central-tx-1', cbu: '9'.repeat(22) },
    });
    const service = buildService(mocks);

    const result = await service.crearTransferenciaPorContrato({
      cbuOrigen: origin.cbu,
      cbuDestino: '9'.repeat(22),
      importe: 100,
      saldoOrigen: 5000,
      usuarioActual: usuarioCliente,
      ipAddress: '127.0.0.1',
    });

    expect(result.statusCode).toBe(201);
    expect(result.stateLabel).toBe('aprobada');
    expect(result.transaccion.id).toBe('tx-1');
    expect(mocks.escribirLogDeAuditoria).toHaveBeenCalledOnce();
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
    prepararQueriesDeTransferencia(mocks.mockClient, {
      origin,
      insertedRow: { id: 'tx-2', estado: 'rechazada', monto: '1000' },
    });
    const err = new HttpError(422, 'Saldo insuficiente');
    err.details = { centralBank: { idTransaccion: 'central-rejected', cbu: '9'.repeat(22) } };
    mocks.centralBankService.crearTransaccion.mockRejectedValueOnce(err);
    const service = buildService(mocks);

    const result = await service.crearTransferenciaPorContrato({
      cbuOrigen: origin.cbu,
      cbuDestino: '9'.repeat(22),
      importe: 1000,
      saldoOrigen: 50,
      usuarioActual: usuarioCliente,
      ipAddress: '127.0.0.1',
    });

    expect(result.statusCode).toBe(422);
    expect(result.stateLabel).toBe('rechazada');
  });

  it('lanza 404 si el CBU origen no existe localmente', async () => {
    const mocks = buildMocks();
    prepararQueriesDeTransferencia(mocks.mockClient, {
      origin: null,
      insertedRow: { id: 'never' },
    });
    const service = buildService(mocks);

    await expect(
      service.crearTransferenciaPorContrato({
        cbuOrigen: '0'.repeat(22),
        cbuDestino: '9'.repeat(22),
        importe: 100,
        saldoOrigen: 100,
        usuarioActual: usuarioCliente,
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
      service.crearTransferenciaPorContrato({
        cbuOrigen: '1'.repeat(22),
        cbuDestino: '9'.repeat(22),
        importe: 100,
        saldoOrigen: 100,
        usuarioActual: usuarioCliente,
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

// ── crearDeposito ───────────────────────────────────────────────────────────

describe('crearDeposito', () => {
  function setupDepositQueries(mockClient, { destination, insertedRow }) {
    mockClient.query.mockImplementation((sqlOrConfig) => {
      const text = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig?.text || '';

      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) {
        return Promise.resolve({ rows: [] });
      }
      // obtenerCuentaLocalPorId (destino)
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

    const result = await service.crearDeposito({
      cuenta_destino_id: 'c-1',
      monto: 500,
      descripcion: 'Depósito sucursal centro',
      usuarioActual: usuarioInterno,
      ipAddress: '127.0.0.1',
    });

    expect(result.transaccion.id).toBe('tx-deposit-1');
    expect(result.destinationName).toBe('Juan Pérez');
    expect(mocks.escribirLogDeAuditoria).toHaveBeenCalledOnce();

    // Verifica que se haya hecho UPDATE de saldo con el monto correcto.
    const updateCalls = mocks.mockClient.query.mock.calls.filter((c) =>
      (typeof c[0] === 'string' ? c[0] : c[0]?.text || '').startsWith('UPDATE cuentas SET saldo')
    );
    expect(updateCalls).toHaveLength(1);
    // El importe viaja como string decimal exacto, no como float: `Dinero`
    // normaliza antes de tocar la BD para no perder centavos por IEEE-754.
    expect(updateCalls[0][1]).toEqual(['500.00', 'c-1']);
  });

  it('rechaza monto = 0 con 400', async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await expect(
      service.crearDeposito({
        cuenta_destino_id: 'c-1',
        monto: 0,
        usuarioActual: usuarioInterno,
        ipAddress: '127.0.0.1',
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  it('rechaza monto negativo con 400', async () => {
    const mocks = buildMocks();
    const service = buildService(mocks);

    await expect(
      service.crearDeposito({
        cuenta_destino_id: 'c-1',
        monto: -100,
        usuarioActual: usuarioInterno,
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
      service.crearDeposito({
        cuenta_destino_id: 'c-ghost',
        monto: 100,
        usuarioActual: usuarioInterno,
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
      service.crearDeposito({
        cuenta_destino_id: 'c-1',
        monto: 100,
        usuarioActual: usuarioInterno,
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
      service.crearDeposito({
        cuenta_destino_id: 'c-1',
        monto: 100,
        usuarioActual: usuarioInterno,
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
