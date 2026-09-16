// Servicios y recargas, con el proveedor y la base inyectados.
//
// Lo que estos tests cuidan es el orden de las operaciones: el débito ocurre
// **sólo** si el proveedor confirmó. Si rechaza o no responde, el cliente no
// puede quedar con menos plata y sin la factura paga.

import { describe, it, expect, vi } from 'vitest';

const { createServiciosService } = await import('../../src/modules/servicios-service.js');
const { createRecargasService } = await import('../../src/modules/recargas-service.js');

const FACTURA = {
  id: 'fac-edenor-202608',
  empresa_id: 'edenor',
  numero_cliente: '123456789',
  periodo: '2026-08',
  importe: 45320.75,
  vencimiento: '2026-09-20',
  estado: 'impaga',
};

const CUENTA_ARS = { id: 'c-ars', persona_id: 'p1', cbu: '1'.repeat(22), moneda: 'ARS', saldo: '100000.00', activa: true };

/**
 * @param {object} o
 * @param {object} o.cuenta      Fila que devuelve el SELECT ... FOR UPDATE.
 * @param {object} o.proveedores Sobrescribe métodos del cliente del proveedor.
 */
function armar({ cuenta = CUENTA_ARS, proveedores = {} } = {}) {
  const escrituras = [];

  const client = {
    query: vi.fn(async (sql, params) => {
      const t = typeof sql === 'string' ? sql : sql.text;
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(t)) {
        escrituras.push([t.toLowerCase()]);
        return { rows: [], rowCount: 0 };
      }
      if (t.includes('FROM cuentas')) return { rows: cuenta ? [cuenta] : [], rowCount: cuenta ? 1 : 0 };
      if (t.includes('FROM tipos_transaccion')) return { rows: [{ id: 'tt-pago' }], rowCount: 1 };
      if (t.includes('UPDATE cuentas')) {
        escrituras.push(['debito', params[0]]);
        return { rows: [], rowCount: 1 };
      }
      if (t.includes('INSERT INTO transacciones')) {
        escrituras.push(['movimiento', params[3], params[5]]);
        return { rows: [{ id: 'mov-1', monto: params[3], canal: params[5] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = { connect: vi.fn(async () => client), query: client.query };

  const proveedor = {
    listarEmpresas: vi.fn(async () => [{ id: 'edenor', nombre: 'Edenor', rubro: 'luz', formato_numero_cliente: '9 dígitos' }]),
    consultarDeuda: vi.fn(async () => ({ numero_cliente: '123456789', total_adeudado: 45320.75, facturas: [{ ...FACTURA }] })),
    pagarFactura: vi.fn(async () => ({ factura: { ...FACTURA, estado: 'pagada' }, comprobante: 'PAG-1', fecha_pago: '2026-09-16T00:00:00.000Z' })),
    listarOperadoras: vi.fn(async () => [{ id: 'movistar', nombre: 'Movistar', montos_disponibles: [500, 1000, 2000] }]),
    recargar: vi.fn(async () => ({ id: 'rec-1', operadora: 'Movistar', numero: '3514123456', monto: 1000, estado: 'acreditada', fecha: '2026-09-16T00:00:00.000Z' })),
    ...proveedores,
  };

  const comun = { pool, proveedores: proveedor, escribirLogDeAuditoria: vi.fn() };
  return {
    servicios: createServiciosService(comun),
    recargas: createRecargasService(comun),
    proveedor,
    escrituras,
  };
}

const hizoRollback = (escrituras) => escrituras.some(([op]) => op === 'rollback');
const debito = (escrituras) => escrituras.find(([op]) => op === 'debito');

describe('pago de servicios', () => {
  const pago = { cuenta_id: 'c-ars', empresa_id: 'edenor', numero_cliente: '123456789', factura_id: FACTURA.id };

  it('debita el monto de la factura y devuelve el comprobante', async () => {
    const { servicios, escrituras } = armar();
    const r = await servicios.pagarFactura({ ...pago });

    expect(r.comprobante).toBe('PAG-1');
    expect(r.factura.monto).toBe(45320.75);
    expect(debito(escrituras)).toEqual(['debito', '45320.75']);
    expect(escrituras).toContainEqual(['movimiento', '45320.75', 'pago_servicio']);
  });

  it('el monto sale de la factura, no del cliente', async () => {
    // Mandar un importe propio no tiene efecto: si se pudiera, se pagaría una
    // factura de 45.000 enviando 1.
    const { servicios, proveedor } = armar();
    await servicios.pagarFactura({ ...pago, monto: 1, importe: 1 });

    expect(proveedor.pagarFactura).toHaveBeenCalledWith('edenor', { facturaId: FACTURA.id, importe: 45320.75 }, null);
  });

  it('si el proveedor rechaza, no se debita nada', async () => {
    const { servicios, escrituras } = armar({
      proveedores: {
        pagarFactura: vi.fn(async () => {
          throw Object.assign(new Error('El proveedor rechazó la operación.'), { status: 502 });
        }),
      },
    });

    await expect(servicios.pagarFactura({ ...pago })).rejects.toMatchObject({ status: 502 });
    expect(debito(escrituras)).toBeUndefined();
    expect(hizoRollback(escrituras)).toBe(true);
  });

  it('si el proveedor no responde, no se debita nada', async () => {
    const { servicios, escrituras } = armar({
      proveedores: {
        pagarFactura: vi.fn(async () => {
          throw Object.assign(new Error('El proveedor no está disponible.'), { status: 503 });
        }),
      },
    });

    await expect(servicios.pagarFactura({ ...pago })).rejects.toMatchObject({ status: 503 });
    expect(debito(escrituras)).toBeUndefined();
    expect(hizoRollback(escrituras)).toBe(true);
  });

  it('saldo insuficiente: 422 y no se le pide nada al proveedor', async () => {
    const { servicios, proveedor, escrituras } = armar({ cuenta: { ...CUENTA_ARS, saldo: '100.00' } });

    await expect(servicios.pagarFactura({ ...pago })).rejects.toMatchObject({ status: 422 });
    expect(proveedor.pagarFactura).not.toHaveBeenCalled();
    expect(debito(escrituras)).toBeUndefined();
  });

  it('no se paga desde una cuenta en dólares', async () => {
    const { servicios, proveedor } = armar({ cuenta: { ...CUENTA_ARS, moneda: 'USD' } });

    await expect(servicios.pagarFactura({ ...pago })).rejects.toMatchObject({ status: 400 });
    expect(proveedor.pagarFactura).not.toHaveBeenCalled();
  });

  it('no se paga desde una cuenta ajena', async () => {
    const { servicios } = armar();
    await expect(
      servicios.pagarFactura({ ...pago, usuarioActual: { persona_id: 'otra', roles: ['cliente'] } })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('una factura que no figura impaga da 404', async () => {
    const { servicios } = armar({
      proveedores: { consultarDeuda: vi.fn(async () => ({ numero_cliente: '123456789', total_adeudado: 0, facturas: [] })) },
    });
    await expect(servicios.pagarFactura({ ...pago })).rejects.toMatchObject({ status: 404 });
  });

  it('un cliente al día devuelve la lista vacía, no un error', async () => {
    const { servicios } = armar({
      proveedores: { consultarDeuda: vi.fn(async () => ({ numero_cliente: '111', total_adeudado: 0, facturas: [] })) },
    });

    const r = await servicios.consultarDeuda({ empresaId: 'edenor', numeroCliente: '111' });
    expect(r.facturas).toEqual([]);
    expect(r.total_adeudado).toBe(0);
    expect(r.empresa.nombre).toBe('Edenor');
  });

  it('la factura se expone con `monto`, no con `importe`', async () => {
    const { servicios } = armar();
    const r = await servicios.consultarDeuda({ empresaId: 'edenor', numeroCliente: '123456789' });

    expect(r.facturas[0]).toHaveProperty('monto', 45320.75);
    expect(r.facturas[0]).not.toHaveProperty('importe');
  });
});

describe('recargas', () => {
  const recarga = { cuenta_id: 'c-ars', operadora_id: 'movistar', numero: '3514123456', monto: 1000 };

  it('debita y registra el movimiento con su canal', async () => {
    const { recargas, escrituras } = armar();
    const r = await recargas.recargar({ ...recarga });

    expect(r.recarga.estado).toBe('acreditada');
    expect(escrituras).toContainEqual(['movimiento', '1000.00', 'recarga_celular']);
  });

  it('rechaza un monto que la operadora no acepta, sin llamar al proveedor', async () => {
    const { recargas, proveedor } = armar();

    await expect(recargas.recargar({ ...recarga, monto: 1234 })).rejects.toMatchObject({ status: 400 });
    expect(proveedor.recargar).not.toHaveBeenCalled();
  });

  it('si la operadora rechaza el número, no se debita', async () => {
    const { recargas, escrituras } = armar({
      proveedores: {
        recargar: vi.fn(async () => {
          throw Object.assign(new Error('La operadora rechazó la recarga.'), { status: 502 });
        }),
      },
    });

    await expect(recargas.recargar({ ...recarga, numero: '3514120000' })).rejects.toMatchObject({ status: 502 });
    expect(debito(escrituras)).toBeUndefined();
    expect(hizoRollback(escrituras)).toBe(true);
  });

  it('saldo insuficiente: 422 antes de contactar a la operadora', async () => {
    const { recargas, proveedor } = armar({ cuenta: { ...CUENTA_ARS, saldo: '10.00' } });

    await expect(recargas.recargar({ ...recarga })).rejects.toMatchObject({ status: 422 });
    expect(proveedor.recargar).not.toHaveBeenCalled();
  });

  it('no se recarga desde una cuenta en dólares', async () => {
    const { recargas } = armar({ cuenta: { ...CUENTA_ARS, moneda: 'USD' } });
    await expect(recargas.recargar({ ...recarga })).rejects.toMatchObject({ status: 400 });
  });
});
